// Card attachments (HI-1700): an image pasted into a card dialog's comment box is a draft (a chip, a link at the caret,
// nothing stored), and Post keeps it with the card: shown inline in the comment and in the card's Attachments list, kept
// in the project's .hive/attachments/cards/<number>, and listed by path in the card's JSON (the Agent API, as
// hive_read_task reads it). It stays through a move to Doing, archiving and back, and moves with the card to another
// project. A session's file is copied to a card from the Attachments tab (Attach to a card, the menu a pane's chip uses
// too), and the tab's Cards section lists the project's card files. Screenshots in both themes. Dev build, throwaway
// profile and workspace (two plain-folder projects).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 20000

const PORT = Number(lib.port(47883))
const userData = path.join(lib.WORK, 'cardattach-profile')
const ws = path.join(lib.WORK, 'cardattach-ws')
const shots = path.join(lib.WORK, 'cardattach-shots')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 150)

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  for (const p of [alpha, beta]) fs.mkdirSync(p, { recursive: true })
  // A session's pasted file in alpha, for Attach to a card from the Attachments tab.
  const sessionFile = path.join(alpha, '.hive', 'attachments', 'run-1', '2026-10-26_12-00-00_session-shot.png')
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  fs.writeFileSync(sessionFile, lib.samplePng(48, 32))
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await inv('settings:update', { agentApi: { enabled: true } })
    await lib.openWorkspace(inv, page, ws)
    for (const p of [alpha, beta]) await inv('project:setActive', p, true)
    const card = await inv('tasks:create', { title: 'Login button misaligned', project: 'alpha' })
    const n = card.number
    const label = await lib.cardLabel(inv, n)

    // --- A paste into the comment box: a draft, then Post keeps it.
    await showBoard(page)
    await openByTitle(page, n)
    const dialog = lib.cardDialog(page, label)
    await dialog.waitFor({ timeout: HUNG_MS })
    const box = dialog.locator('.task-comment-new textarea')
    await box.click()
    await box.fill('The button sits too low: ')
    const png = lib.samplePng(120, 60).toString('base64')
    await box.evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'misaligned.png', { type: 'image/png' }))
      el.setSelectionRange(el.value.length, el.value.length)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, png)
    const draft = dialog.locator('[data-drafts="comment"] .attach-draft')
    check('a pasted image is a draft: a chip under the box', !!(await until(async () => (await draft.count()) === 1)))
    check('…linked in the comment where the caret was', /!\[misaligned\.png\]\(attachment:draft-\d+\)$/.test(await box.inputValue()), await box.inputValue())
    check('…and nothing is stored yet', (await inv('cards:attachments', n)).length === 0)
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
      await dialog.locator('.task-comment-new').screenshot({ path: path.join(shots, `cardattach-draft-${theme}.png`) })
    }
    await dialog.getByRole('button', { name: 'Comment' }).click()
    const kept = await until(async () => {
      const l = await inv('cards:attachments', n)
      return l.length === 1 && l
    })
    check('Post keeps it with the card', !!kept, JSON.stringify(kept))
    const file = kept ? kept[0] : null
    check("…in the project's .hive/attachments/cards/<number>", !!file && file.path.toLowerCase().startsWith(path.join(alpha, '.hive', 'attachments', 'cards', String(n)).toLowerCase() + path.sep) && fs.existsSync(file.path), file?.path)
    const shown = dialog.locator('.task-comment .markdown img')
    check('…shown inline in the comment', !!(await until(async () => (await shown.count()) === 1 && (await shown.evaluate((img) => img.complete && img.naturalWidth > 0)))))
    check("…and listed in the card's Attachments", !!(await until(async () => (await dialog.locator('[data-section="attachments"] .card-attachment').count()) === 1)))
    check('the draft chip is gone', (await draft.count()) === 0)
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
      await dialog.screenshot({ path: path.join(shots, `cardattach-dialog-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
    await page.keyboard.press('Escape')

    // --- The card's JSON lists it by path, as hive_read_task reads it, and its comment's link reads as that path.
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const get = async () => (await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${n}`, { headers: { Authorization: `Bearer ${token}` } })).json()
    const view = await get()
    check("the card's JSON lists it by path", view.attachments?.length === 1 && view.attachments[0].path === file?.path && view.attachments[0].name === 'misaligned.png', JSON.stringify(view.attachments))
    check("…and its comment's link reads as that path", view.comments.at(-1).text.includes(`](${file?.path})`), view.comments.at(-1).text)

    // --- It stays through a move to Doing, archiving and back, and follows a move to another project.
    await inv('tasks:update', n, { column: 'doing' })
    check('kept when the card moves to Doing', fs.existsSync(file.path) && (await inv('cards:attachments', n)).length === 1)
    await inv('tasks:archive', n, true)
    check('kept when it is archived', fs.existsSync(file.path) && (await inv('cards:attachments', n)).length === 1)
    await inv('tasks:archive', n, false)
    await inv('tasks:update', n, { project: 'beta' })
    const moved = await inv('cards:attachments', n)
    check('a move to another project takes it along', moved.length === 1 && moved[0].path.toLowerCase().startsWith(path.join(beta, '.hive', 'attachments', 'cards').toLowerCase()) && fs.existsSync(moved[0].path), JSON.stringify(moved.map((x) => x.path)))
    check('…and the old folder goes', !!(await until(async () => !fs.existsSync(path.join(alpha, '.hive', 'attachments', 'cards', String(n))))))

    // --- A session's file copied to a card from the Attachments tab; the tab's Cards section.
    const other = await inv('tasks:create', { title: 'Session shot belongs here', project: 'alpha' })
    await page.locator('.activity-btn[aria-label="Projects"]').click()
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await page.keyboard.press('Alt+7')
    const tile = page.locator('.images-page .image-group .thumb').filter({ has: page.locator('img[alt$="session-shot.png"]') })
    check('the Attachments tab shows the session file', !!(await until(async () => (await tile.count()) === 1)))
    await tile.click({ button: 'right' })
    await page.locator('.menu-item', { hasText: 'Attach to a card' }).click()
    const otherLabel = await lib.cardLabel(inv, other.number)
    await page.locator('.menu-item', { hasText: otherLabel }).first().click()
    const copied = await until(async () => {
      const l = await inv('cards:attachments', other.number)
      return l.length === 1 && l
    })
    check("Attach to a card copies a session's file to the card", !!copied && fs.existsSync(sessionFile), JSON.stringify(copied))
    const section = page.locator('[data-section="card-attachments"]')
    check("the tab's Cards section lists it under its card", !!(await until(async () => (await section.locator(`[data-card="${other.number}"] .thumb`).count()) === 1)))
    check('…the sessions under a heading of their own, Sessions (1)', (await page.locator('[data-section="session-attachments"]').innerText().catch(() => '')).toLowerCase().includes('sessions (1)'), await page.locator('[data-section="session-attachments"]').innerText().catch(() => ''))
    check("…and the tab's total counts both", (await page.locator('.images-toolbar .faint').first().innerText()).includes('1 on cards, 1 in 1 session'), await page.locator('.images-toolbar .faint').first().innerText())
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
      await page.locator('.images-page').screenshot({ path: path.join(shots, `cardattach-tab-${theme}.png`) })
    }
    // Storage: a row of their own.
    const storage = await inv('storage:project', alpha, true).catch(() => null)
    check('Storage counts card attachments on their own row', !storage || storage.cardAttachments > 0, JSON.stringify(storage && { attachments: storage.attachments, cards: storage.cardAttachments }))
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} failed` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
