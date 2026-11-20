// Unsaved edits: renames/moves carry them, delete warns, quit asks (save / discard / conflict). Dev build, throwaway profile.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const scratch = lib.WORK
const userData = path.join(scratch, 'usprofile')
const ws = path.join(scratch, 'usws')
const proj = path.join(ws, 'demo')
const HUNG_MS = lib.timing('hang.ui')
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
  await lib.until(async () => page.evaluate((n) => document.title.includes(n), path.basename(ws)), lib.timing('hang.ui'))
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Files' }).click()
  await lib.until(async () => (await page.locator('.file-row').count()) > 0, HUNG_MS)
  return { app, page }
}

/** A test Combwork's processes (its main process and what it started), by identity: taken before it quits. */
const ownTree = (app) => [...lib.identify([app.process().pid]), ...lib.processTree(app.process().pid)]

/**
 * Combwork quits (#424): it decides to within ms of the watch's quit (its own quit work: saving, stopping), then its process
 * ends. The process's part is Electron's, which a loaded machine stretches to seconds, so it is only waited for, and then
 * every process it started (`tree`, ownTree's): an Electron child can outlive the main process, holding the profile's
 * single-instance lock, and the next launch would quit as already running (HI-2836).
 */
const quits = async (q, tree, ms = 8000) => {
  if (!(await q.untilDecided(ms)) || !(await q.gone(30000))) return false
  return !!(await lib.until(() => lib.stillSame(tree).length === 0, HUNG_MS))
}

;(async () => {
  // ---- Run 1: rename, folder rename, delete, then quit and save.
  fresh()
  let { app, page } = await launch()
  const row = (rel) => page.locator(`.file-row[data-rel="${rel}"]`)
  const pane = { locator: (sel) => page.locator('.split-main').locator(sel) }
  const edit = async (rel, text) => {
    await row(rel).click()
    await lib.until(async () => (await pane.locator('.monaco .view-lines').count()) === 1, lib.timing('hang.ui'))
    await pane.locator('.monaco').first().click({ position: { x: 300, y: 20 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.type(text)
    await lib.until(async () => (await row(rel).locator('.dirty-dot').count()) === 1, HUNG_MS)
  }
  const selected = async (rel) => ((await row(rel).getAttribute('class').catch(() => '')) ?? '').split(' ').includes('selected')
  const rename = async (rel, name) => {
    await row(rel).click()
    await lib.until(() => selected(rel), HUNG_MS)
    await page.keyboard.press('F2')
    await page.locator('.inline-name').fill(name)
    await page.keyboard.press('Enter')
    // Renamed once the tree lists the new name and not the old (its drafts are moved before the tree is read again).
    const renamed = rel.includes('/') ? `${rel.slice(0, rel.lastIndexOf('/') + 1)}${name}` : name
    await lib.until(async () => (await row(renamed).count()) === 1 && (await row(rel).count()) === 0, HUNG_MS)
  }

  await edit('a.ts', 'export const edited = true\n')
  check('draft: a.ts marked', (await row('a.ts').locator('.dirty-dot').count()) === 1)
  await rename('a.ts', 'b.ts')
  check('rename: file renamed on disk', exists('b.ts') && !exists('a.ts'))
  check('rename: b.ts carries the unsaved mark', (await row('b.ts').locator('.dirty-dot').count()) === 1)
  await row('b.ts').click()
  await lib.until(async () => (await pane.locator('.monaco').first().innerText().catch(() => '')).includes('edited'), lib.timing('hang.ui'))
  check('rename: b.ts opens with the unsaved edits', (await pane.locator('.monaco').first().innerText()).includes('edited'))

  // Folder rename carries a draft inside it.
  // A click on a folder opens it (or closes an open one).
  await row('docs').click()
  await lib.until(async () => (await row('docs/c.ts').count()) === 1, HUNG_MS)
  await edit('docs/c.ts', 'export const inFolder = true\n')
  // Selecting docs to rename it closed it, so notes is closed too: opened to see c.ts.
  await rename('docs', 'notes')
  if (!(await row('notes/c.ts').count())) await row('notes').click()
  await lib.until(async () => (await row('notes/c.ts').count()) === 1, HUNG_MS)
  check('folder rename: notes/c.ts carries the unsaved mark', (await row('notes/c.ts').locator('.dirty-dot').count()) === 1)

  // Delete a file with unsaved edits: the confirmation says so, and the edits go with it.
  await edit('gone.ts', 'export const x = 2\n')
  await row('gone.ts').click()
  await lib.until(() => selected('gone.ts'), HUNG_MS)
  await page.keyboard.press('Delete')
  await lib.until(async () => (await page.locator('.dialog').count()) > 0, HUNG_MS)
  const dialogText = await page.locator('.dialog').last().innerText().catch(() => '')
  check('delete: warns about unsaved changes', /Unsaved changes to gone\.ts will be lost/.test(dialogText), dialogText.replace(/\s+/g, ' ').slice(0, 200))
  await page.getByRole('button', { name: 'Move to Recycle Bin' }).click()
  // Gone from disk, and then its unsaved changes dropped (the editor's dot goes): what Quit lists below depends on both.
  check('delete: file gone, and its unsaved changes with it', !!(await lib.until(async () => !exists('gone.ts') && (await pane.locator('.editor-toolbar .dirty-dot').count()) === 0, lib.timing('hang.ui'))))

  // Quit: the dialog lists the two unsaved files (not the deleted one), Save and quit saves them.
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  await lib.until(async () => /unsaved changes/.test(await page.locator('.dialog').last().innerText().catch(() => '')), HUNG_MS)
  const quitText = await page.locator('.dialog').last().innerText().catch(() => '')
  check('quit: asks with no sessions running', /unsaved changes/.test(quitText))
  check('quit: lists b.ts and c.ts, not gone.ts', /b\.ts/.test(quitText) && /c\.ts/.test(quitText) && !/gone\.ts/.test(quitText), quitText.replace(/\s+/g, ' ').slice(0, 300))
  await page.screenshot({ path: path.join(scratch, 'us-1-quit.png') })
  const q1 = await lib.quitWatch(app)
  const t1 = ownTree(app)
  await page.getByRole('button', { name: 'Save and quit' }).click()
  check('quit/save: Combwork quit', await quits(q1, t1))
  check('quit/save: b.ts saved', read('b.ts').includes('edited'))
  check('quit/save: notes/c.ts saved', read('notes/c.ts').includes('inFolder'))

  // ---- Run 2: discard.
  ;({ app, page } = await launch())
  await edit('keep.ts', 'export const discardMe = true\n')
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  await page.getByRole('button', { name: 'Discard the changes' }).click()
  const q2 = await lib.quitWatch(app)
  const t2 = ownTree(app)
  await page.locator('.dialog-footer button.danger').last().click()
  check('quit/discard: Combwork quit', await quits(q2, t2))
  check('quit/discard: keep.ts unchanged', !read('keep.ts').includes('discardMe'))

  // ---- Run 3: a file changed on disk can't be saved over; Combwork stays open.
  ;({ app, page } = await launch())
  await edit('keep.ts', 'export const mine = true\n')
  fs.writeFileSync(path.join(proj, 'keep.ts'), 'export const theirs = true\n')
  // Seen by Combwork: the open file's banner says it changed on disk.
  await lib.until(async () => (await page.getByText('keep.ts has changed on disk since you opened it').count()) > 0, HUNG_MS)
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  await page.getByRole('button', { name: 'Save and quit' }).click()
  // Its save answered (it couldn't, and says Combwork stays open): it has decided not to quit, so it hasn't.
  check('conflict: says it stays open', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'so Combwork is still open' }).count()) > 0, HUNG_MS)))
  check('conflict: Combwork still open', !app.process().killed && app.process().exitCode === null)
  check('conflict: disk version kept', read('keep.ts').includes('theirs') && !read('keep.ts').includes('mine'))
  check('conflict: dialog still lists keep.ts', /keep\.ts/.test(await page.locator('.dialog').last().innerText().catch(() => '')))
  await page.getByRole('button', { name: 'Cancel' }).click()
  await lib.until(async () => (await page.locator('.dialog').count()) === 0, HUNG_MS)
  check('conflict: edits still there after cancel', (await row('keep.ts').locator('.dirty-dot').count()) === 1)

  // Reload Window offers to save first.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }))
  })
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  await page.getByRole('button', { name: 'Discard the changes' }).click()
  const q3 = await lib.quitWatch(app)
  const t3 = ownTree(app)
  await page.locator('.dialog-footer button.danger').last().click()
  check('conflict: discard then quits', await quits(q3, t3))

  console.log(results.join('\n'))
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
