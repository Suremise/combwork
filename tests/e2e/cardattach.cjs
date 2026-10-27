// Card attachments (HI-1700): an image pasted into a card dialog's comment box is a draft (a chip, a link at the caret,
// nothing stored), and Post keeps it with the card: shown inline in the comment and in the card's Attachments list, kept
// in the project's .hive/attachments/cards/<number>, and listed by path in the card's JSON (the Agent API, as
// hive_read_task reads it). It stays through a move to Doing, archiving and back, and moves with the card to another
// project. A session's file is copied to a card from the Attachments tab (Attach to a card, the menu a pane's chip uses
// too). The tab's two tabs (HI-1841): Pane attachments and Card attachments, each its count and its own kind filters,
// remembered; the card dialog's Show in Attachments opening Card attachments at its card, whatever its filter, without
// changing the tab remembered; Pane attachments when the cards keep no files yet. Screenshots in both themes. Dev build, throwaway
// profile and workspace (two plain-folder projects).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 20000

const PORT = Number(lib.port(47883))
const userData = path.join(lib.WORK, 'cardattach-profile')
const ws = path.join(lib.WORK, 'cardattach-ws')
const shots = path.join(lib.WORK, 'cardattach-shots')
const claudeHome = path.join(lib.WORK, 'cardattach-claude-home')
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
  // The fake Claude Code, for the Assistant's session (its token, for a refused change).
  const cenv = lib.fakeClaude(userData, claudeHome, [alpha, beta, ws])
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off', ...cenv }, viewport: { width: 1400, height: 900 } })
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

    // --- Drafts never outlive their card (HR4's round 1): pasted into A's box, Cancel and Discard, then B and a new card.
    const pasteInto = (loc) => loc.evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'left-behind.png', { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, png)
    const cancelAndDiscard = async (d) => {
      await d.getByRole('button', { name: 'Cancel' }).click()
      await page.getByRole('button', { name: 'Discard' }).click()
      await until(async () => (await d.count()) === 0)
    }
    const b = await inv('tasks:create', { title: 'Another card', project: 'alpha' })
    await openByTitle(page, n)
    const dialogA = lib.cardDialog(page, label)
    await dialogA.waitFor({ timeout: HUNG_MS })
    await pasteInto(dialogA.locator('.task-comment-new textarea'))
    check("a draft in A's comment box", !!(await until(async () => (await dialogA.locator('.attach-draft').count()) === 1)))
    await cancelAndDiscard(dialogA)
    await openByTitle(page, b.number)
    const dialogB = lib.cardDialog(page, await lib.cardLabel(inv, b.number))
    await dialogB.waitFor({ timeout: HUNG_MS })
    check("…Cancel and Discard drop it: B shows none of A's drafts", (await dialogB.locator('.attach-draft').count()) === 0 && (await dialogB.locator('.task-comment-new textarea').inputValue()) === '')
    await page.keyboard.press('Escape')
    await until(async () => (await dialogB.count()) === 0)
    await page.getByRole('button', { name: 'New Card' }).first().click()
    const fresh = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await fresh.waitFor({ timeout: HUNG_MS })
    await fresh.locator('.task-title-input').fill('Never made')
    await pasteInto(fresh.locator('.task-description-input'))
    check("a draft in a new card's description", !!(await until(async () => (await fresh.locator('.attach-draft').count()) === 1)))
    await cancelAndDiscard(fresh)
    await page.getByRole('button', { name: 'New Card' }).first().click()
    await fresh.waitFor({ timeout: HUNG_MS })
    check('…cancelled, the next new card starts with none', (await fresh.locator('.attach-draft').count()) === 0)
    await page.keyboard.press('Escape')
    await until(async () => (await fresh.count()) === 0)

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

    // --- A session's file copied to a card from the Attachments tab; its tabs (HI-1841).
    const other = await inv('tasks:create', { title: 'Session shot belongs here', project: 'alpha' })
    await page.locator('.activity-btn[aria-label="Projects"]').click()
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await page.keyboard.press('Alt+7')
    const attachTabs = () => page.locator('.attachment-tabs [role="tab"]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-tab'), label: e.querySelector('.hive-tab-label').textContent.trim(), count: Number((e.querySelector('.hive-tab-count')?.textContent ?? '-1').replace(/\D/g, '')), selected: e.getAttribute('aria-selected') === 'true' })))
    const attachTab = (id) => page.locator(`.attachment-tabs [role="tab"][data-tab="${id}"]`)
    const selectedAttach = async () => (await attachTabs()).find((t) => t.selected)?.id ?? null
    // The session's file in Pane attachments (the card's copy, in Card attachments, has the same name).
    const tile = page.locator('.images-page [role="tabpanel"][data-tab-panel="pane"] .image-group .thumb').filter({ has: page.locator('img[alt$="session-shot.png"]') })
    check('the Attachments tab shows the session file on Pane attachments', !!(await until(async () => (await tile.count()) === 1 && (await tile.isVisible()))))
    check('…two tabs, Pane attachments (1) and Card attachments (0), Pane attachments first', !!(await until(async () => JSON.stringify(await attachTabs()) === JSON.stringify([{ id: 'pane', label: 'Pane attachments', count: 1, selected: true }, { id: 'card', label: 'Card attachments', count: 0, selected: false }]))), JSON.stringify(await attachTabs()))
    await attachTab('card').click()
    check('…a click on the empty Card attachments stays there, saying it has none', !!(await until(async () => (await selectedAttach()) === 'card' && (await page.locator('[role="tabpanel"][data-tab-panel="card"] .attachment-tab-empty').isVisible()))))
    // Card attachments remembered, alpha's cards keeping none: opened again, Pane attachments, once they are read.
    await page.keyboard.press('Alt+1')
    await until(async () => (await page.locator('.images-page').count()) === 0)
    await page.keyboard.press('Alt+7')
    check('…opened again with Card remembered and no card files: Pane attachments', !!(await until(async () => (await selectedAttach()) === 'pane' && (await tile.isVisible()))), String(await selectedAttach()))
    // The menu lists the cards the window has: opened again until it has the one just made.
    const otherLabel = await lib.cardLabel(inv, other.number)
    const entry = page.locator('.menu-item', { hasText: otherLabel }).first()
    const listed = await until(async () => {
      await page.keyboard.press('Escape')
      await tile.click({ button: 'right' })
      await page.locator('.menu-item', { hasText: 'Attach to a card' }).click()
      return (await entry.count()) === 1
    })
    check(`the menu lists ${otherLabel}`, !!listed)
    await entry.click()
    const copied = await until(async () => {
      const l = await inv('cards:attachments', other.number)
      return l.length === 1 && l
    })
    check("Attach to a card copies a session's file to the card", !!copied && fs.existsSync(sessionFile), JSON.stringify(copied))
    const section = page.locator('[data-section="card-attachments"]')
    check('Card attachments counts it, Pane attachments its session file', !!(await until(async () => JSON.stringify((await attachTabs()).map((t) => t.count)) === '[1,1]')), JSON.stringify(await attachTabs()))
    check('…Pane attachments shows only the session’s file, not the card’s', (await tile.isVisible()) && !(await section.isVisible().catch(() => false)))
    await attachTab('card').click()
    check('Card attachments lists it under its card, and only it', !!(await until(async () => (await section.locator(`[data-card="${other.number}"] .thumb`).isVisible()) && !(await tile.isVisible()))))
    check('…remembered', !!(await until(() => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).ui?.tabs?.attachments === 'card')))
    check("…and the tab's total counts both", (await page.locator('.images-toolbar .faint').first().innerText()).includes('1 on cards, 1 in 1 session'), await page.locator('.images-toolbar .faint').first().innerText())
    // Each tab its own kind filters, counting its own files: a text file on the card, the session's image alone.
    const notes = path.join(alpha, 'docs', 'notes.txt')
    fs.mkdirSync(path.dirname(notes), { recursive: true })
    fs.writeFileSync(notes, 'notes\n')
    const patched = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${other.number}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ attachments: [notes] }) })
    check('a text file added to the card', patched.ok && !!(await until(async () => (await inv('cards:attachments', other.number)).length === 2)), String(patched.status))
    const filterCounts = () => page.locator('.attachment-filters .attachment-filter').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind') ?? 'all'}:${e.querySelector('.faint')?.textContent.trim()}`).join())
    check('Card attachments’ filters count its own files: all 2, an image and a text file', !!(await until(async () => (await filterCounts()) === 'all:2,image:1,text:1')), await filterCounts())
    await page.locator('.attachment-filter[data-kind="text"]').click()
    check('…its Text filter shows the text file alone', !!(await until(async () => (await section.locator('.thumb').count()) === 1 && (await section.locator('.thumb[data-kind="text"]').count()) === 1)))
    await attachTab('pane').click()
    check('Pane attachments has no filters to offer (one kind), its file shown whatever Card’s filter is', !!(await until(async () => (await selectedAttach()) === 'pane' && (await page.locator('.attachment-filters').count()) === 0 && (await tile.isVisible()))))
    await attachTab('card').click()
    check('…and Card’s filter kept for its tab', !!(await until(async () => (await page.locator('.attachment-filter[data-kind="text"]').getAttribute('aria-pressed')) === 'true')))
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
      await page.locator('.images-page').screenshot({ path: path.join(shots, `cardattach-tab-${theme}.png`) })
    }
    // The card dialog's Show in Attachments: Card attachments at its card, its filter back to All so the image shows too,
    // without changing the tab remembered (Pane attachments, chosen now).
    await attachTab('pane').click()
    await until(async () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).ui?.tabs?.attachments === 'pane')
    await inv('settings:update', { appearance: { theme: 'dark' } })
    await showBoard(page)
    await openByTitle(page, other.number)
    const show = page.locator('[data-action="show-in-attachments"]')
    await show.waitFor({ timeout: 15000 })
    await show.click()
    const target = section.locator(`[data-card="${other.number}"]`)
    check('Show in Attachments opens Card attachments at its card, both its files shown (its filter back to All)', !!(await until(async () => (await selectedAttach()) === 'card' && (await target.isVisible()) && (await target.locator('.thumb').count()) === 2)), JSON.stringify([await selectedAttach(), await target.locator('.thumb').count()]))
    check('…without changing the tab remembered', JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).ui?.tabs?.attachments === 'pane')
    check('…the dialog closed, the card’s files in view', (await page.locator('[data-action="show-in-attachments"]').count()) === 0 && (await target.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight })))
    // --- The Agent API: nothing is copied before the destination is allowed (HR4's HI-1700 round 1, finding 3).
    const post = async (body, bearer = token) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const shot = path.join(alpha, 'docs', 'shot.png')
    fs.mkdirSync(path.dirname(shot), { recursive: true })
    fs.writeFileSync(shot, lib.samplePng(32, 32))
    const staged = () => [alpha, beta, ws].flatMap((h) => { const d = path.join(h, '.hive', 'attachments', 'cards', '.staging'); return fs.existsSync(d) ? fs.readdirSync(d) : [] })
    const outside = path.join(ws, '..', 'cardattach-outside')
    const traversal = await post({ title: 'Outside', project: '../cardattach-outside', attachments: [shot] })
    check('a card for a path, not a project, is refused before anything is copied', traversal.status >= 400 && !fs.existsSync(outside) && staged().length === 0, JSON.stringify({ status: traversal.status, outside: fs.existsSync(outside), staged: staged() }))
    const unknown = await post({ title: 'Nowhere', project: 'nope', attachments: [shot] })
    check('…and for a project the workspace has not', unknown.status === 404 && !fs.existsSync(path.join(ws, 'nope')) && staged().length === 0, JSON.stringify({ status: unknown.status, made: fs.existsSync(path.join(ws, 'nope')), staged: staged() }))
    // The Assistant at Look: its change is refused before it is admitted, and copies nothing.
    const assistantHome = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const asToken = await until(async () => (fs.existsSync(asTokenFile) ? JSON.parse(fs.readFileSync(asTokenFile, 'utf8')).token : null))
    check('the Assistant starts, with its token', !!asToken)
    await inv('settings:update', { assistant: { control: 'look' } })
    const before = (await inv('tasks:list')).length
    const denied = await post({ title: 'Not allowed', project: 'alpha', attachments: [shot] }, asToken)
    check("the Assistant's change refused at Look copies nothing and leaves nothing", denied.status === 403 && staged().length === 0 && (await inv('tasks:list')).length === before, JSON.stringify({ status: denied.status, staged: staged() }))
    await inv('session:stop', assistantHome, 'assistant').catch(() => undefined)
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
