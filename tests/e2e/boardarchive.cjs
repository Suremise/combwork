// The archived cards as a table (#249): Archived (n) on the board shows them in a DataTable, newest archived first,
// with paging (rows per page remembered), sorting, filters (text for number, title and agent; a choice for project,
// labels and the column a card was archived from), the board's search narrowing it too; a row opens its card (from the
// keyboard too, while Enter on its Unarchive button unarchives it, #267); Unarchive
// brings one back to the end of its column, and Unarchive Selected every selected one (also all that match a filter).
// 35 archived fake cards, no agents. Both themes. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'boardarchive-profile')
const ws = path.join(lib.WORK, 'boardarchive-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(path.join(ws, 'alpha'))
  lib.gitProject(path.join(ws, 'beta'))
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = (fn, ms = 10000) => lib.until(fn, ms)

  // 35 cards, archived in order (the last archived is the newest): alpha and beta, labels, from every column.
  const columns = ['hold', 'todo', 'doing', 'review', 'passed', 'done']
  const made = []
  for (let i = 1; i <= 35; i++) {
    const c = await inv('tasks:create', { title: `${i % 7 === 0 ? 'Login' : 'Card'} number ${i}`, project: i % 2 ? 'alpha' : 'beta', column: columns[i % 6], labels: i % 5 === 0 ? ['bug', 'ui'] : i % 3 === 0 ? ['docs'] : [], ...(columns[i % 6] === 'doing' ? { agent: '' } : {}) })
    made.push(c)
  }
  for (const c of made) await inv('tasks:archive', c.number, true)
  const live = (await inv('tasks:create', { title: 'Still on the board', project: 'alpha' })).number

  await page.getByRole('button', { name: 'Task Board' }).click()
  await until(async () => (await page.locator(`.task-card[data-task="${live}"]`).count()) === 1, HUNG_MS)
  await page.locator('.board-toolbar label', { hasText: 'Archived (35)' }).click()
  const table = page.locator('.archived-cards')
  const rows = table.locator('tbody tr.clickable')
  const numbers = () => rows.evaluateAll((trs) => trs.map((tr) => Number(tr.querySelector('.task-number')?.getAttribute('data-task'))))
  // A card as the table names it (#1221): its key.
  const label = (n) => made.find((c) => c.number === n)?.key ?? `#${n}`
  check('Archived shows the archived cards as a table', !!(await until(async () => (await rows.count()) > 0, HUNG_MS)))
  const headers = await table.locator('thead tr').first().locator('th').allInnerTexts()
  check('with its columns: number, title, project, labels, agent, from, archived, created', JSON.stringify(headers.map((h) => h.trim().toUpperCase())) === JSON.stringify(['', '#', 'TITLE', 'PROJECT', 'LABELS', 'AGENT', 'FROM', 'ARCHIVED', 'CREATED', '']), JSON.stringify(headers))
  check('its cards are named by key (#1221)', (await rows.first().locator('.task-number').innerText()) === made[34].key && /^[A-Z]{2,4}-\d+$/.test(made[34].key ?? ''), await rows.first().locator('.task-number').innerText())
  check('a page of 20, newest archived first', (await rows.count()) === 20 && (await numbers())[0] === made[34].number && (await numbers())[1] === made[33].number, JSON.stringify(await numbers()))
  check('the pages say where they are', /1–20 of 35/.test(await table.locator('.table-range').innerText()) && /Page 1 of 2/.test(await table.locator('.table-page').innerText()))
  await page.screenshot({ path: path.join(lib.WORK, 'boardarchive-dark.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await lib.sleep(200)
  await page.screenshot({ path: path.join(lib.WORK, 'boardarchive-light.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  // Sorting by number, both ways.
  await table.getByRole('button', { name: '#', exact: true }).click()
  check('sorts by number (highest first)', !!(await until(async () => (await numbers())[0] === made[34].number && (await numbers())[1] === made[33].number - 0, HUNG_MS)))
  await table.getByRole('button', { name: '#', exact: true }).click()
  check('…and the other way', !!(await until(async () => (await numbers())[0] === made[0].number, HUNG_MS)), JSON.stringify(await numbers()))

  // Filters: title text, the project, a label, the column it was archived from; the number and agent are text too.
  const filter = (name) => table.getByLabel(`Filter ${name}`)
  await filter('Title').fill('login')
  check('a text filter on the title', !!(await until(async () => (await numbers()).length === 5 && (await rows.allInnerTexts()).every((t) => /Login/.test(t)), HUNG_MS)), JSON.stringify(await numbers()))
  await filter('Title').fill('')
  await filter('Project').selectOption('beta')
  check('a choice of project', !!(await until(async () => (await numbers()).length === 17, HUNG_MS)), JSON.stringify(await numbers()))
  await filter('Project').selectOption('')
  const labelChoices = await filter('Labels').locator('option').allInnerTexts()
  check('labels offer each label once', JSON.stringify(labelChoices) === JSON.stringify(['All', 'bug', 'docs', 'ui']), JSON.stringify(labelChoices))
  await filter('Labels').selectOption('ui')
  check('a card shows for any of its labels', !!(await until(async () => (await numbers()).length === 7, HUNG_MS)), JSON.stringify(await numbers()))
  await filter('Labels').selectOption('')
  await filter('From').selectOption({ label: 'Approved' })
  check('a choice of the column it was archived from, by its name', !!(await until(async () => (await numbers()).length === 6 && (await rows.allInnerTexts()).every((t) => t.includes('Approved')), HUNG_MS)), JSON.stringify(await numbers()))
  await filter('From').selectOption('')
  await filter('#').fill('#1')
  check('a text filter on the number', !!(await until(async () => (await numbers()).every((n) => String(n).startsWith('1')), HUNG_MS)))
  await filter('#').fill('')

  // The board's search narrows the table too.
  await page.locator('.board-search input').fill('number 3')
  check("the board's search narrows the rows", !!(await until(async () => (await numbers()).length === 7, HUNG_MS)), JSON.stringify(await numbers()))
  await page.locator('.board-search input').fill('')

  // Rows per page, remembered.
  await table.locator('.table-page-size select').selectOption('50')
  check('rows per page shows them all', !!(await until(async () => (await rows.count()) === 35, HUNG_MS)))

  // A row opens its card (archived: read-only, with Bring Back). The table is sorted by number, lowest first, now.
  const firstShown = (await numbers())[0]
  await rows.first().click()
  const dialog = page.locator('.dialog', { hasText: label(firstShown) })
  check('a row opens its card', !!(await until(async () => (await dialog.count()) === 1, 5000)) && /Archived/.test(await dialog.innerText()))
  await page.keyboard.press('Escape')
  await until(async () => (await dialog.count()) === 0, 5000)

  // Unarchive one: back at the end of the column it was archived from.
  const one = made.find((c) => c.number === firstShown)
  await rows.first().getByRole('button', { name: 'Unarchive' }).click()
  const back = await until(async () => {
    const c = (await inv('tasks:list')).find((x) => x.number === one.number)
    return !c.archived && c
  }, 5000)
  check('Unarchive brings a card back to the column it was archived from', !!back && back.column === one.column, JSON.stringify(back && { column: back.column, was: one.column }))
  check('…and it leaves the table', !!(await until(async () => (await rows.count()) === 34, HUNG_MS)))

  // From the keyboard (#267): Enter and Space on a row open its card; Enter on its Unarchive button unarchives it and
  // doesn't open it.
  const keyCard = made[10]
  const keyRow = async () => rows.nth((await numbers()).indexOf(keyCard.number))
  const keyDialog = page.locator('.dialog', { hasText: label(keyCard.number) })
  for (const key of ['Enter', ' ']) {
    await (await keyRow()).focus()
    await page.keyboard.press(key)
    check(`${key === ' ' ? 'Space' : 'Enter'} on a row opens its card`, !!(await until(async () => (await keyDialog.count()) === 1, 5000)))
    await page.keyboard.press('Escape')
    await until(async () => (await keyDialog.count()) === 0, 5000)
  }
  await (await keyRow()).getByRole('button', { name: 'Unarchive' }).focus()
  await page.keyboard.press('Enter')
  check('Enter on a row’s Unarchive unarchives the card', !!(await until(async () => !(await inv('tasks:list')).find((x) => x.number === keyCard.number).archived, 5000)))
  check('…without opening it', (await keyDialog.count()) === 0 && !!(await until(async () => (await rows.count()) === 33, HUNG_MS)), String(await rows.count()))

  // Select several, Unarchive Selected.
  const picks = [made[1], made[2], made[3]]
  for (const c of picks) await table.getByLabel(`Select ${label(c.number)}`, { exact: true }).check()
  const bulk = page.getByRole('button', { name: /Unarchive Selected \(3\)/ })
  check('the selection is counted', (await bulk.count()) === 1 && /3 selected/.test(await page.locator('.task-archive-actions').innerText()))
  await bulk.click()
  const allBack = await until(async () => {
    const list = await inv('tasks:list')
    return picks.every((p) => list.find((x) => x.number === p.number && !x.archived && x.column === p.column)) && list
  }, 8000)
  check('Unarchive Selected brings each back to its own column', !!allBack)
  check('the table and its selection follow', !!(await until(async () => (await rows.count()) === 30, HUNG_MS)) && (await page.locator('.task-archive-actions button').innerText()).trim().endsWith('Unarchive Selected'))

  // Select all that match a filter (on every page), then bring them back.
  await table.locator('.table-page-size select').selectOption('10')
  await filter('Project').selectOption('alpha')
  const matching = (await inv('tasks:list')).filter((c) => c.archived && c.project === 'alpha').length
  await table.getByLabel(/^Select all \d+ matching rows$/).check()
  check('select all takes every matching row, on every page', /\(\d+\)/.test(await page.locator('.task-archive-actions button').innerText()) && (await page.locator('.task-archive-actions button').innerText()).includes(`(${matching})`), `${matching}: ${await page.locator('.task-archive-actions button').innerText()}`)
  await page.getByRole('button', { name: /Unarchive Selected/ }).click()
  check('…and brings them all back', !!(await until(async () => (await inv('tasks:list')).filter((c) => c.archived && c.project === 'alpha').length === 0, 10000)))
  await filter('Project').selectOption('')

  // Rows per page is remembered after a reload.
  await page.reload()
  await lib.appReady(page)
  await page.getByRole('button', { name: 'Task Board' }).click().catch(() => undefined)
  await page.locator('.board-toolbar label', { hasText: 'Archived (' }).click()
  await until(async () => (await rows.count()) > 0, HUNG_MS)
  check('rows per page is kept', (await table.locator('.table-page-size select').inputValue()) === '10' && (await rows.count()) === 10, await table.locator('.table-page-size select').inputValue())

  await app.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
