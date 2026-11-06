// Cards an older version saved after the board moved to its database (#1017's downgrade), set aside, and their review
// (#1044, Darren's decision on #1017: the only way they reach the board): the notice offers Review…, whose dialog lists
// each card (its old number, whether it is free, who made it, a preview); Add to Board keeps a free old number, gives a
// taken one the next free number, with a history line by Repair; Discard… asks, then sends the file to the trash. The
// board's ⋯ menu offers Set-Aside Cards (n)… while any remain. Both themes. No agents. Dev build, throwaway profile and
// workspaces.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'setaside-profile')
const ws = path.join(lib.WORK, 'setaside-ws')
const other = path.join(lib.WORK, 'setaside-other')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** A card file as an older Combwork saves it in `.combwork/tasks`. */
const olderCard = (number, fields) =>
  JSON.stringify({ number, title: `Card ${number}`, description: '', project: 'alpha', agent: null, column: 'todo', order: number, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '2026-10-05T09:30:00.000Z', createdBy: 'You', updatedAt: '2026-10-05T09:30:00.000Z', ...fields }, null, 2) + '\n'

;(async () => {
  for (const d of [userData, ws, other]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(path.join(other, 'beta'))
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-coder', name: 'Coder' }] }))
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    // The board as 0.9 keeps it: #1 and #2, and the stub an older version reads.
    const one = await inv('tasks:create', { title: 'On the board', project: 'alpha' })
    const two = await inv('tasks:create', { title: 'Links to #1', project: 'alpha' })
    await inv('tasks:update', two.number, { links: [one.number] })
    const stub = path.join(ws, '.combwork', 'tasks')
    check('the stub is there for older versions', fs.existsSync(path.join(stub, 'board.json')))

    // Another workspace meanwhile; then an older version saves three files in the stub: a card with a free number, one
    // whose number the board has, and a damaged one.
    await lib.openWorkspace(inv, page, other)
    const free = Number(JSON.parse(fs.readFileSync(path.join(stub, 'board.json'), 'utf8')).next)
    fs.writeFileSync(path.join(stub, `${free}.json`), olderCard(free, { title: 'Made in the older Combwork', description: 'Written **while** the workspace was open in 0.8.\n\nIt has a second paragraph.', labels: ['old'], comments: [{ at: '2026-10-05T09:31:00.000Z', by: 'You', text: 'A comment from then', id: 'c1' }] }))
    fs.writeFileSync(path.join(stub, `${one.number}.json`), olderCard(one.number, { title: 'Also made as #1', createdBy: 'Assistant', column: 'review' }))
    fs.writeFileSync(path.join(stub, `${free + 1}.json`), '{ damaged')
    await lib.openWorkspace(inv, page, ws)

    // The notice, with Review….
    const toast = page.locator('.toast', { hasText: 'made by an older Combwork' })
    check('a notice says three cards made by an older Combwork were found', !!(await lib.until(async () => (await toast.count()) === 1, HUNG_MS)) && /3 cards made by an older Combwork/.test(await toast.innerText()), await toast.innerText().catch(() => ''))
    await page.screenshot({ path: path.join(lib.WORK, 'setaside-notice.png') })
    await toast.getByRole('button', { name: 'Review…' }).click()
    const dialog = page.locator('.dialog', { hasText: 'Cards Made by an Older Combwork' })
    const rows = dialog.locator('.set-aside-card')
    check('Review… lists the three files', !!(await lib.until(async () => (await rows.count()) === 3, HUNG_MS)), String(await rows.count()))
    const row = (file) => dialog.locator(`.set-aside-card[data-file="${file}"]`)
    const clash = await row(`${one.number}.json`).innerText()
    check('the clashing card says its number is taken here', /is taken here/.test(clash) && /Made by Assistant/.test(clash) && /Review/.test(clash), clash)
    const freeText = await row(`${free}.json`).innerText()
    check('the free card says Add keeps its number, with its project, comments and a preview', new RegExp(`Add keeps #${free}`).test(freeText) && /alpha · Todo · 1 comment/.test(freeText) && /Written while the workspace/.test(freeText), freeText)
    check('the damaged file can only be discarded', /can only be discarded/.test(await row(`${free + 1}.json`).innerText()) && (await row(`${free + 1}.json`).getByRole('button', { name: 'Add to Board' }).count()) === 0)
    check('the dialog says nothing is rewritten', /Nothing is rewritten/.test(await dialog.innerText()))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: path.join(lib.WORK, `setaside-dialog-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    // Add the free one: its old number, everything it had, a line by Repair.
    await row(`${free}.json`).getByRole('button', { name: 'Add to Board' }).click()
    check('Add takes it out of the list', !!(await lib.until(async () => (await rows.count()) === 2, HUNG_MS)))
    const added = (await inv('tasks:list')).find((c) => c.number === free)
    const last = added?.history?.at(-1)
    check('it is on the board under its old number, as it was', added?.title === 'Made in the older Combwork' && added.labels.join() === 'old' && added.comments.length === 1, JSON.stringify(added))
    check('its history says where it came from, by Repair', last?.by === 'Repair' && last.what === `Added from an older Combwork, where it was made as #${free}`, JSON.stringify(last))

    // Add the clashing one: the next free number; #1 and the link to it unchanged.
    await row(`${one.number}.json`).getByRole('button', { name: 'Add to Board' }).click()
    check('…and the clashing one', !!(await lib.until(async () => (await rows.count()) === 1, HUNG_MS)))
    const board = await inv('tasks:list')
    const renumbered = board.find((c) => c.title === 'Also made as #1')
    check('the clashing one gets a new number, past every other', !!renumbered && renumbered.number > free + 1 && renumbered.column === 'review', JSON.stringify(renumbered))
    check('#1 and the link to it unchanged', board.find((c) => c.number === one.number)?.title === 'On the board' && board.find((c) => c.number === two.number)?.links.join() === String(one.number))
    await page.screenshot({ path: path.join(lib.WORK, 'setaside-added.png') })

    // The board's ⋯ menu offers it while one is left.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Task Board' }).click()
    await page.locator('.board-more').click()
    const item = page.getByText('Set-Aside Cards (1)…')
    check("the board's ⋯ menu offers Set-Aside Cards (1)…", !!(await lib.until(async () => (await item.count()) === 1, HUNG_MS)))
    await item.click()
    check('…which opens the dialog', !!(await lib.until(async () => (await rows.count()) === 1, HUNG_MS)))

    // Discard asks, then the file goes to the trash.
    await row(`${free + 1}.json`).getByRole('button', { name: 'Discard…' }).click()
    const ask = page.locator('.dialog', { hasText: 'Discard "' })
    check('Discard asks first', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)))
    await page.screenshot({ path: path.join(lib.WORK, 'setaside-discard.png') })
    await ask.getByRole('button', { name: 'Discard', exact: true }).click()
    check('…then the list is empty', !!(await lib.until(async () => /No cards are set aside/.test(await dialog.innerText()), HUNG_MS)))
    check('…and the file is in the trash', !!(await lib.until(async () => lib.trashed(path.join('setaside-ws', '.combwork', 'tasks.set-aside', `${free + 1}.json`)).length === 1, HUNG_MS)))
    check('the set-aside folder is empty', fs.readdirSync(path.join(ws, '.combwork', 'tasks.set-aside')).length === 0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    // The toolbar reads the count again as the board changes: the menu, opened again until then, stops offering it.
    const menuWithout = async () => {
      await page.locator('.board-more').click()
      const shown = (await page.getByText('Export Board to JSON…').count()) === 1
      const without = shown && (await page.getByText(/Set-Aside Cards/).count()) === 0
      await page.keyboard.press('Escape')
      return without
    }
    check("the ⋯ menu doesn't offer it with none left", !!(await lib.until(menuWithout, HUNG_MS)))
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
