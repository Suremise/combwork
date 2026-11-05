// Archiving in bulk (#351): each column's ⋯ menu has "Archive All in <Column> (n)…" and the board's ⋯ menu "Archive All
// Cards (n)…". Done asks plainly; a card an agent is working on is skipped (listed) unless "Also archive cards agents are
// working on" is ticked; with a search only the cards shown are archived ("Archive the 2 Shown (of 4)…"); Archive All
// Cards counts per column. Each is a batch: the toast's Undo brings it back to its columns and order, and Archived's
// Batch offers "Unarchive this batch" later. The Agent API can't archive. A card an agent takes while an archive is on its
// way stays on the board. The agent runs the fake Claude Code. Both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'boardbulk-profile')
const ws = path.join(lib.WORK, 'boardbulk-ws')
const claudeHome = path.join(lib.WORK, 'boardbulk-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47920))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(path.join(ws, 'beta'))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = (fn, ms = 10000) => lib.until(fn, ms)
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  // Archived cards in full (#1017: the window has them in short until its Archived view opens).
  const all = () => inv('tasks:list', true)
  // A column's cards on the board, top to bottom.
  const order = async (col) =>
    (await all())
      .filter((c) => !c.archived && c.column === col)
      .sort((a, b) => a.order - b.order || a.number - b.number)
      .map((c) => c.number)
  const archivedNow = async (n) => (await all()).find((c) => c.number === n)?.archived
  const column = (id) => page.locator(`.board-column[data-column="${id}"]`)
  const dialog = page.locator('.dialog', { has: page.locator('.archive-all') })
  const item = (text) => page.locator('.menu .menu-item', { hasText: text })
  const openColumnMenu = async (id, label) => column(id).getByRole('button', { name: `${label}: more` }).click()
  const shot = async (name) => {
    await page.screenshot({ path: path.join(lib.WORK, `boardbulk-${name}-dark.png`) })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await lib.sleep(200)
    await page.screenshot({ path: path.join(lib.WORK, `boardbulk-${name}-light.png`) })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
  // The newest toast saying so (an earlier one may still be showing).
  const toast = page.locator('.toast', { hasText: /Archived \d+ cards?/ }).last()

  // An agent, B4, running (the fake Claude Code), with a card in Doing.
  const b4 = await lib.addAgent(inv, alpha, { name: 'B4' })
  await inv('session:start', alpha, { agentId: b4.id })
  check('B4 is running', !!(await until(async () => (await inv('session:live')).some((s) => s.agentId === b4.id), 20000)))

  const make = async (title, col, project = 'alpha', extra = {}) => (await inv('tasks:create', { title, project, column: col, ...extra })).number
  const done = [await make('Done one', 'done'), await make('Done two', 'done', 'beta'), await make('Done three', 'done'), await make('Done four', 'done')]
  const todo = [await make('Plan the release', 'todo'), await make('Login page', 'todo', 'beta'), await make('Write the notes', 'todo'), await make('Login form', 'todo')]
  const busy = await make('Being built', 'doing', 'alpha', { agent: b4.id })
  const idle = await make('Nobody on it', 'doing', 'alpha', { agent: '' })
  const held = await make('Parked', 'hold')
  const doneOrder = await order('done')

  await page.getByRole('button', { name: 'Task Board' }).click()
  await until(async () => (await page.locator(`.task-card[data-task="${held}"]`).count()) === 1, HUNG_MS)

  // 1. Done: a plain confirm, a toast with Undo that puts them back where they were.
  await openColumnMenu('done', 'Done')
  check('the Done menu offers Archive All in Done (4)…', (await item('Archive All in Done (4)…').count()) === 1)
  await item('Archive All in Done (4)…').click()
  check('…which asks plainly', !!(await until(async () => (await dialog.count()) === 1, 5000)) && /Archive All in Done\?/.test(await dialog.locator('.dialog-header').innerText()) && /Archive 4 cards in Done\? You can unarchive them from Archived\./.test(await dialog.innerText()), await dialog.innerText().catch(() => ''))
  check('…naming no skipped cards in Done', (await dialog.locator('.dialog-list').count()) === 0)
  await shot('done')
  await dialog.getByRole('button', { name: 'Archive 4 cards' }).click()
  check('Done is archived', !!(await until(async () => (await order('done')).length === 0, 5000)))
  check('a toast says so, with Undo', !!(await until(async () => (await toast.count()) === 1, 5000)) && /Archived 4 cards/.test(await toast.innerText()))
  const history = (await all()).find((c) => c.number === done[0]).history.at(-1)
  check("each card's history says it went in a batch", /^Archived in a batch of 4 \(All in Done\)$/.test(history.what) && history.by === 'You', JSON.stringify(history))
  await toast.getByRole('button', { name: 'Undo' }).click()
  check('Undo brings them back to Done, in their order', !!(await until(async () => JSON.stringify(await order('done')) === JSON.stringify(doneOrder), 5000)), JSON.stringify(await order('done')))

  // 2. Active: the card B4 is working on is skipped and listed; ticking the box takes it too.
  await openColumnMenu('doing', 'Active')
  await item('Archive All in Active (2)…').click()
  await until(async () => (await dialog.count()) === 1, 5000)
  const text = await dialog.innerText()
  check('a card an agent is working on is listed as skipped', text.includes(`${await lib.cardLabel(inv, busy)} Being built · B4 is working on it · skipped`), text)
  check('…and the confirm archives only the other', /Archive 1 card in Active\?/.test(text) && (await dialog.getByRole('button', { name: 'Archive 1 card' }).count()) === 1)
  await dialog.getByRole('checkbox', { name: 'Also archive cards agents are working on' }).check()
  check('ticking the box counts it in, with a warning', (await dialog.getByRole('button', { name: 'Archive 2 cards' }).count()) === 1 && /Their agents lose their card/.test(await dialog.innerText()))
  await shot('doing')
  await dialog.getByRole('checkbox', { name: 'Also archive cards agents are working on' }).uncheck()
  await dialog.getByRole('button', { name: 'Archive 1 card' }).click()
  check('the card nobody is on is archived, the one B4 has stays', !!(await until(async () => (await archivedNow(idle)) === true, 5000)) && (await archivedNow(busy)) === false)
  await openColumnMenu('doing', 'Active')
  await item('Archive All in Active (1)…').click()
  await until(async () => (await dialog.count()) === 1, 5000)
  check('with only cards agents are on, nothing to archive until the box is ticked', /Tick the box below to archive it anyway/.test(await dialog.innerText()) && (await dialog.getByRole('button', { name: 'Archive 0 cards' }).isDisabled()))
  await dialog.getByRole('checkbox', { name: 'Also archive cards agents are working on' }).check()
  await dialog.getByRole('button', { name: 'Archive 1 card' }).click()
  check('…and ticked, it is archived', !!(await until(async () => (await archivedNow(busy)) === true, 5000)))
  check('Doing is now empty', (await order('doing')).length === 0)

  // 3. With a search, only the cards shown.
  await page.locator('.board-search input').fill('login')
  await openColumnMenu('todo', 'Todo')
  check('a search makes it "Archive the 2 Shown (of 4)…"', (await item('Archive the 2 Shown (of 4)…').count()) === 1)
  await item('Archive the 2 Shown (of 4)…').click()
  await until(async () => (await dialog.count()) === 1, 5000)
  check('…and the confirm says so', /Archive the 2 Shown in Todo\?/.test(await dialog.innerText()) && /Archive the 2 cards shown in Todo \(of 4\)\?/.test(await dialog.innerText()) && /hides stay on the board/.test(await dialog.innerText()), await dialog.innerText())
  await dialog.getByRole('button', { name: 'Archive 2 cards' }).click()
  check('only the cards shown are archived', !!(await until(async () => (await archivedNow(todo[1])) && (await archivedNow(todo[3])), 5000)) && !(await archivedNow(todo[0])) && !(await archivedNow(todo[2])))
  await page.locator('.board-search input').fill('')

  // 4. Archive All Cards: counted per column, a danger confirm; Undo restores every column and its order.
  const before = { hold: await order('hold'), todo: await order('todo'), done: await order('done') }
  await page.getByRole('button', { name: 'Board: more' }).click()
  const total = before.hold.length + before.todo.length + before.done.length
  check(`the board's menu offers Archive All Cards (${total})…`, (await item(`Archive All Cards (${total})…`).count()) === 1)
  await item(`Archive All Cards (${total})…`).click()
  await until(async () => (await dialog.count()) === 1, 5000)
  check('it counts per column', (await dialog.locator('.archive-all-counts').innerText()) === `On Hold 1 · Todo 2 · Done 4`, await dialog.locator('.archive-all-counts').innerText().catch(() => ''))
  check('…with a danger button', /danger/.test(await dialog.getByRole('button', { name: `Archive ${total} cards` }).getAttribute('class')))
  await shot('all')
  await dialog.getByRole('button', { name: `Archive ${total} cards` }).click()
  check('the board is empty', !!(await until(async () => (await all()).every((c) => c.archived), 5000)))
  await toast.getByRole('button', { name: 'Undo' }).click()
  const after = async () => ({ hold: await order('hold'), todo: await order('todo'), done: await order('done') })
  check('Undo restores every column and its order', !!(await until(async () => JSON.stringify(await after()) === JSON.stringify(before), 5000)), JSON.stringify(await after()))

  // 5. Archived: Batch picks one bulk archive; "Unarchive this batch" brings it back where it was, later.
  await openColumnMenu('done', 'Done')
  await item('Archive All in Done (4)…').click()
  await until(async () => (await dialog.count()) === 1, 5000)
  await dialog.getByRole('button', { name: 'Archive 4 cards' }).click()
  await until(async () => (await order('done')).length === 0, 5000)
  await page.locator('.toast .icon-btn[aria-label="Dismiss"], .toast button[title="Dismiss"]').first().click().catch(() => undefined)
  await page.locator('.board-toolbar label', { hasText: 'Archived (' }).click()
  const batchSelect = page.getByLabel('Batch')
  check('Archived offers the batches', !!(await until(async () => (await batchSelect.count()) === 1, 5000)))
  const options = await batchSelect.locator('option').allInnerTexts()
  check('…each with when, what and how many', options.some((o) => o.endsWith('All in Done · 4 cards')), JSON.stringify(options))
  const value = await batchSelect.locator('option', { hasText: 'All in Done · 4 cards' }).getAttribute('value')
  await batchSelect.selectOption(value)
  const rows = page.locator('.archived-cards tbody tr.clickable')
  check('picking one shows its cards', !!(await until(async () => (await rows.count()) === 4, 5000)))
  await shot('batch')
  await page.getByRole('button', { name: 'Unarchive this batch (4)' }).click()
  check('Unarchive this batch brings Done back in its order', !!(await until(async () => JSON.stringify(await order('done')) === JSON.stringify(doneOrder), 5000)), JSON.stringify(await order('done')))
  check('…and the batch is gone from the list', !!(await until(async () => (await batchSelect.count()) === 0 || !(await batchSelect.locator('option').allInnerTexts()).some((o) => o.endsWith('All in Done · 4 cards')), 5000)))

  // 6. The Agent API can't archive: not a field of a change, and no bulk call.
  const patch = await api('PATCH', `/v1/tasks/${todo[0]}`, { archived: true })
  check('PATCH with archived is refused (403)', patch.status === 403 && /Only the user archives/.test(JSON.stringify(patch.body)), JSON.stringify(patch))
  check('…and the card stays on the board', (await archivedNow(todo[0])) === false)
  const bulk = await api('POST', '/v1/tasks/archive', { cards: [todo[0]] })
  check('there is no bulk archive call', bulk.status === 404 || bulk.status === 405, String(bulk.status))

  // 7. A card an agent takes while the archive is on its way (#351 review): main checks each card as it archives it,
  // so it stays, and the toast says why.
  await page.locator('.board-toolbar label', { hasText: 'Archived (' }).click()
  const race = await make('Taken meanwhile', 'todo')
  await until(async () => (await page.locator(`.task-card[data-task="${race}"]`).count()) === 1, 5000)
  await app.evaluate(() => {
    process.env.HIVE_TEST_SLOW_IPC = 'tasks:archiveBatch=2500*1'
  })
  const todoCount = (await order('todo')).length
  await openColumnMenu('todo', 'Todo')
  await item(`Archive All in Todo (${todoCount})…`).click()
  await until(async () => (await dialog.count()) === 1, 5000)
  check('the card is idle when the dialog opens', !(await dialog.innerText()).includes('Taken meanwhile'))
  await dialog.getByRole('button', { name: `Archive ${todoCount} cards` }).click()
  await lib.sleep(300)
  await inv('tasks:update', race, { column: 'doing', agent: b4.id })
  const raced = page.locator('.toast', { hasText: `Archived ${todoCount - 1} card` }).last()
  check('the card an agent took meanwhile stays on the board', !!(await until(async () => (await order('todo')).length === 0, 8000)) && (await archivedNow(race)) === false)
  check('…and the toast says why', !!(await until(async () => (await raced.count()) === 1, 5000)) && (await raced.innerText()).includes(`One card was left on the board: ${await lib.cardLabel(inv, race)} moved to Active`), await raced.innerText().catch(() => ''))
  await app.evaluate(() => {
    delete process.env.HIVE_TEST_SLOW_IPC
  })

  // 8. Every card it would archive leaves while the dialog is open (#1463): it says none is left, with Archive
  // disabled and no box to tick, never that agents are on them.
  await page.locator('.toast .icon-btn[aria-label="Dismiss"], .toast button[title="Dismiss"]').first().click().catch(() => undefined)
  const leaving = await make('Leaves meanwhile', 'todo')
  await until(async () => (await page.locator(`.task-card[data-task="${leaving}"]`).count()) === 1, 5000)
  await openColumnMenu('todo', 'Todo')
  await item('Archive All in Todo (1)…').click()
  check('the dialog opens with the card to archive', !!(await until(async () => (await dialog.count()) === 1 && (await dialog.getByRole('button', { name: 'Archive 1 card' }).isEnabled()), 5000)))
  await inv('tasks:update', leaving, { column: 'review' })
  const noneLeft = 'No cards are left in Todo to archive: they moved on while this was open.'
  check('once it leaves, the dialog says none is left', !!(await until(async () => (await dialog.innerText()).includes(noneLeft), 5000)), await dialog.innerText().catch(() => ''))
  check('…with Archive disabled, no box to tick and no word of agents', (await dialog.getByRole('button', { name: 'Archive 0 cards' }).isDisabled()) && (await dialog.locator('input[type="checkbox"]').count()) === 0 && !(await dialog.innerText()).includes('an agent is on'), await dialog.innerText().catch(() => ''))
  await shot('none-left')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  check('Cancel closes it, the card where it went', !!(await until(async () => (await dialog.count()) === 0, 5000)) && (await archivedNow(leaving)) === false)

  await app.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
