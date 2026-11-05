// Unsaved edits: renames/moves carry them, delete warns, quit asks (save / discard / conflict). Dev build, throwaway profile.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const scratch = lib.WORK
const userData = path.join(scratch, 'usprofile')
const ws = path.join(scratch, 'usws')
const proj = path.join(ws, 'demo')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : `  (${extra})`}`)
const read = (rel) => fs.readFileSync(path.join(proj, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(proj, rel))

function fresh() {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(proj, 'docs', 'c.ts'), 'export const c = 1\n')
  fs.writeFileSync(path.join(proj, 'gone.ts'), 'export const gone = 1\n')
  fs.writeFileSync(path.join(proj, 'keep.ts'), 'export const keep = 1\n')
}

async function launch() {
  lib.enableProviders(userData)
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47897) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  page.on('close', () => console.log('DEBUG page closed at', new Date().toISOString()))
  app.process().on('exit', (c) => console.log('DEBUG exit', c, new Date().toISOString()))
  app.process().stderr.on('data', (d) => /error|quit/i.test(String(d)) && console.log('DEBUG stderr', String(d).slice(0, 300)))
  await lib.appReady(page)
  await page.evaluate((folder) => window.combwork.invoke('workspace:open', folder), ws)
  await lib.until(async () => page.evaluate((n) => document.title.includes(n), path.basename(ws)), 20000)
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Files' }).click()
  await sleep(800)
  return { app, page }
}

/**
 * Combwork quits (#424): it decides to within ms of the watch's quit (its own quit work: saving, stopping), then its process
 * ends. The process's part is Electron's, which a loaded machine stretches to seconds, so it is only waited for.
 */
const quits = async (q, ms = 8000) => {
  if (!(await q.untilDecided(ms)) || !(await q.gone(30000))) return false
  await sleep(2500) // on purpose: the single-instance lock goes a moment after the process, before the next launch
  return true
}

;(async () => {
  // ---- Run 1: rename, folder rename, delete, then quit and save.
  fresh()
  let { app, page } = await launch()
  const row = (rel) => page.locator(`.file-row[data-rel="${rel}"]`)
  const pane = { locator: (sel) => page.locator('.split-main').locator(sel) }
  const edit = async (rel, text) => {
    await row(rel).click()
    await lib.until(async () => (await pane.locator('.monaco .view-lines').count()) === 1, 10000)
    await pane.locator('.monaco').first().click({ position: { x: 300, y: 20 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.type(text)
    await sleep(500)
  }
  const rename = async (rel, name) => {
    await row(rel).click()
    await sleep(300)
    await page.keyboard.press('F2')
    await page.locator('.inline-name').fill(name)
    await page.keyboard.press('Enter')
    await sleep(900)
  }

  await edit('a.ts', 'export const edited = true\n')
  check('draft: a.ts marked', (await row('a.ts').locator('.dirty-dot').count()) === 1)
  await rename('a.ts', 'b.ts')
  check('rename: file renamed on disk', exists('b.ts') && !exists('a.ts'))
  check('rename: b.ts carries the unsaved mark', (await row('b.ts').locator('.dirty-dot').count()) === 1)
  await row('b.ts').click()
  await lib.until(async () => (await pane.locator('.monaco').first().innerText().catch(() => '')).includes('edited'), 10000)
  check('rename: b.ts opens with the unsaved edits', (await pane.locator('.monaco').first().innerText()).includes('edited'))

  // Folder rename carries a draft inside it.
  await row('docs').click()
  await sleep(500)
  await row('docs/c.ts').click().catch(() => undefined)
  if (!(await row('docs/c.ts').count())) {
    await row('docs').dblclick()
    await sleep(500)
  }
  await edit('docs/c.ts', 'export const inFolder = true\n')
  await rename('docs', 'notes')
  await row('notes').click()
  await sleep(300)
  if (!(await row('notes/c.ts').count())) {
    await row('notes').dblclick()
    await sleep(600)
  }
  check('folder rename: notes/c.ts carries the unsaved mark', (await row('notes/c.ts').locator('.dirty-dot').count()) === 1)

  // Delete a file with unsaved edits: the confirmation says so, and the edits go with it.
  await edit('gone.ts', 'export const x = 2\n')
  await row('gone.ts').click()
  await sleep(300)
  await page.keyboard.press('Delete')
  await sleep(500)
  const dialogText = await page.locator('.dialog').last().innerText().catch(() => '')
  check('delete: warns about unsaved changes', /Unsaved changes to gone\.ts will be lost/.test(dialogText), dialogText.replace(/\s+/g, ' ').slice(0, 200))
  await page.getByRole('button', { name: 'Move to Recycle Bin' }).click()
  // Gone from disk, and then its unsaved changes dropped (the editor's dot goes): what Quit lists below depends on both.
  check('delete: file gone, and its unsaved changes with it', !!(await lib.until(async () => !exists('gone.ts') && (await pane.locator('.editor-toolbar .dirty-dot').count()) === 0, 10000)))

  // Quit: the dialog lists the two unsaved files (not the deleted one), Save and quit saves them.
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  await sleep(800)
  const quitText = await page.locator('.dialog').last().innerText().catch(() => '')
  check('quit: asks with no sessions running', /unsaved changes/.test(quitText))
  check('quit: lists b.ts and c.ts, not gone.ts', /b\.ts/.test(quitText) && /c\.ts/.test(quitText) && !/gone\.ts/.test(quitText), quitText.replace(/\s+/g, ' ').slice(0, 300))
  await page.screenshot({ path: path.join(scratch, 'us-1-quit.png') })
  const q1 = await lib.quitWatch(app)
  await page.getByRole('button', { name: 'Save and quit' }).click()
  check('quit/save: Combwork quit', await quits(q1))
  check('quit/save: b.ts saved', read('b.ts').includes('edited'))
  check('quit/save: notes/c.ts saved', read('notes/c.ts').includes('inFolder'))

  // ---- Run 2: discard.
  ;({ app, page } = await launch())
  await edit('keep.ts', 'export const discardMe = true\n')
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  await sleep(800)
  await page.getByRole('button', { name: 'Discard the changes' }).click()
  const q2 = await lib.quitWatch(app)
  await page.locator('.dialog-footer button.danger').last().click()
  check('quit/discard: Combwork quit', await quits(q2))
  check('quit/discard: keep.ts unchanged', !read('keep.ts').includes('discardMe'))

  // ---- Run 3: a file changed on disk can't be saved over; Combwork stays open.
  ;({ app, page } = await launch())
  await edit('keep.ts', 'export const mine = true\n')
  fs.writeFileSync(path.join(proj, 'keep.ts'), 'export const theirs = true\n')
  await sleep(300)
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  await sleep(800)
  await page.getByRole('button', { name: 'Save and quit' }).click()
  await lib.sleep(1500) // A fixed wait on purpose: this checks that Combwork does NOT quit, which no condition can show.
  check('conflict: Combwork still open', !app.process().killed && app.process().exitCode === null)
  check('conflict: disk version kept', read('keep.ts').includes('theirs') && !read('keep.ts').includes('mine'))
  check('conflict: dialog still lists keep.ts', /keep\.ts/.test(await page.locator('.dialog').last().innerText().catch(() => '')))
  await page.getByRole('button', { name: 'Cancel' }).click()
  await sleep(500)
  check('conflict: edits still there after cancel', (await row('keep.ts').locator('.dirty-dot').count()) === 1)

  // Reload Window offers to save first.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }))
  })
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  await sleep(600)
  await page.getByRole('button', { name: 'Discard the changes' }).click()
  const q3 = await lib.quitWatch(app)
  await page.locator('.dialog-footer button.danger').last().click()
  check('conflict: discard then quits', await quits(q3))

  console.log(results.join('\n'))
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
