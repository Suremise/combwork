// Files and Attachments tabs, driven end to end in a throwaway profile. Never touches the system clipboard.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const scratch = lib.WORK
const userData = path.join(scratch, 'fprofile')
const ws = path.join(scratch, 'fws')
const shots = path.join(scratch, 'fshots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(shots, { recursive: true })
const proj = path.join(ws, 'demo')
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true })
  fs.writeFileSync(path.join(proj, rel), text)
}
w('README.md', '# demo\n')
w('src/app.ts', 'export const a = 1\n')
w('src/util.ts', 'export const b = 2\n')
w('.gitignore', 'dist/\n')
w('dist/out.js', 'x')
execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: proj, env: lib.gitEnv() })
w('src/app.ts', 'export const a = 2\n') // modified
w('src/new.ts', 'new\n') // untracked
// Fake session attachments: one live-ish group, one archived. Written where Combwork kept them before #387, .combwork/images,
// which Combwork moves to .combwork/attachments; the first group also has a log and a PDF.
const png = lib.samplePng(400, 200)
const ids = ['11111111-aaaa-bbbb-cccc-000000000001', '22222222-aaaa-bbbb-cccc-000000000002']
for (const [i, id] of ids.entries()) {
  const d = path.join(proj, '.combwork', 'images', id)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, `2026-09-29_10-0${i}-00.png`), png)
  fs.writeFileSync(path.join(d, `2026-09-29_10-0${i}-30.png`), png)
}
fs.writeFileSync(path.join(proj, '.combwork', 'images', ids[0], '2026-09-29_09-59-10_build.log'), 'line one\nline two\n')
fs.writeFileSync(path.join(proj, '.combwork', 'images', ids[0], '2026-09-29_09-59-00_notes.md'), '# Notes\n\nSome *notes*.\n')
fs.writeFileSync(path.join(proj, '.combwork', 'images', ids[0], '2026-09-29_09-58-50_table.csv'), 'name,size\nalpha,1\nbeta,2\n')
fs.writeFileSync(path.join(proj, '.combwork', 'images', ids[0], '2026-09-29_09-59-20_report.pdf'), '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
fs.writeFileSync(
  path.join(proj, '.combwork', 'sessions.json'),
  JSON.stringify({ version: 1, sessions: [
    { id: ids[0], agent: 'claude-code', name: 'Fix the login page', createdAt: '', lastActiveAt: '', archived: false },
    { id: ids[1], agent: 'claude-code', name: 'Old experiment', createdAt: '', lastActiveAt: '', archived: true }
  ] })
)
fs.writeFileSync(path.join(scratch, 'from explorer.txt'), 'dropped')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exists = (rel) => fs.existsSync(path.join(proj, rel))
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
const results = []
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Files' }).click()
  await sleep(800)
  const row = (rel) => page.locator(`.file-row[data-rel="${rel}"]`)
  const selected = async (rel) => (await page.locator(`.file-row.selected[data-rel="${rel}"]`).count()) === 1

  await row('src').click()
  await sleep(500)
  await row('src/app.ts').click()
  // A row's classes, '' while it isn't there (git's status arrives after the tree).
  const cls = (loc) => loc.getAttribute('class', { timeout: 1000 }).catch(() => '').then((c) => c ?? '')
  const classed = async (loc, c) => !!(await lib.until(async () => (await cls(loc)).includes(c), HUNG_MS))
  check('git modified colour on src/app.ts', await classed(row('src/app.ts').locator('.label'), 'git-M'))
  check('untracked colour on src/new.ts', await classed(row('src/new.ts').locator('.label'), 'git-U'))
  check('dist is dimmed (gitignored)', await classed(row('dist'), 'ignored'))
  check('.combwork is dimmed', await classed(row('.combwork'), 'ignored'))
  check('.git hidden', (await row('.git').count()) === 0)
  await page.screenshot({ path: path.join(shots, '1-tree.png') })

  // New file with an intermediate folder.
  await page.locator('.files-list .pane-header').getByRole('button', { name: 'New File…' }).click()
  await page.locator('.inline-name').fill('notes/todo.md')
  await page.keyboard.press('Enter')
  check('new file notes/todo.md (from the selected file, so inside src)', !!(await lib.until(() => exists('src/notes/todo.md'), 10000)))
  // The tab then selects the new file: a click before that loses its selection to it.
  check('…and selects the new file', !!(await lib.until(async () => (await page.locator('.file-row.selected[data-rel="src/notes/todo.md"]').count()) === 1, 10000)))

  // Rename README.md with F2.
  await row('README.md').click()
  await page.keyboard.press('F2')
  await page.locator('.inline-name').fill('README2.md')
  await page.keyboard.press('Enter')
  check('rename README.md -> README2.md', !!(await lib.until(() => exists('README2.md') && !exists('README.md'), 10000)))
  // The tab then reloads the folder and selects the renamed file: a click before that loses its selection to it.
  check('…and selects the renamed file', !!(await lib.until(async () => (await page.locator('.file-row.selected[data-rel="README2.md"]').count()) === 1, 10000)))

  // Copy src/util.ts into dist via Ctrl+C / Ctrl+V.
  await row('src/util.ts').click()
  await page.keyboard.press('Control+C')
  await row('dist').click()
  await page.keyboard.press('Control+V')
  check('copy/paste src/util.ts -> dist/util.ts', !!(await lib.until(() => exists('dist/util.ts') && exists('src/util.ts'), 10000)))
  // The tab then reloads dist and selects the copy: a click before that loses its selection to it, and the cut below
  // would take dist/util.ts instead of README2.md (#595).
  check('…and selects the copy', !!(await lib.until(() => selected('dist/util.ts'), HUNG_MS)))

  // Cut README2.md into src.
  await row('README2.md').click()
  await page.keyboard.press('Control+X')
  await row('src').click() // collapses src, still the paste target
  await page.keyboard.press('Control+V')
  // Moved on disk, then the tab selects what it pasted: a click before that loses its selection to it.
  // What didn't hold, when it fails (#595): the move on disk, the rows selected, whether src is open, and any toast.
  const pasted = async () =>
    JSON.stringify({
      moved: exists('src/README2.md'),
      left: exists('README2.md'),
      selected: await page.locator('.file-row.selected').evaluateAll((els) => els.map((e) => e.getAttribute('data-rel'))),
      srcOpen: (await row('src').locator('.codicon-chevron-down').count()) === 1,
      toasts: await page.locator('.toast').allInnerTexts()
    })
  check('cut/paste README2.md -> src/README2.md', !!(await lib.until(async () => exists('src/README2.md') && !exists('README2.md') && (await selected('src/README2.md')), HUNG_MS)), await pasted())

  // Duplicate via the context menu.
  await row('.gitignore').click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Duplicate' }).click()
  check('duplicate .gitignore -> ".gitignore copy"', !!(await lib.until(async () => exists('.gitignore copy') && (await selected('.gitignore copy')), HUNG_MS)))

  // Delete (Recycle Bin) with confirmation.
  await row('.gitignore copy').click()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Recycle Bin' }).click()
  await lib.until(async () => !exists('.gitignore copy'), 10000)
  check('delete moves ".gitignore copy" to the Recycle Bin', !exists('.gitignore copy'))
  // A test copy's Recycle Bin is the suite's own trash folder (#414). Combwork notes the move in trash.jsonl just after it,
  // so the file leaving the project doesn't mean the note is there yet (#441): wait for it.
  check("…the suite's trash folder in a test copy, not the user's", !!(await lib.until(() => lib.trashed('.gitignore copy').some((e) => fs.existsSync(e.to)), 5000)), JSON.stringify(lib.trashed()))

  // Internal drag: move src/new.ts onto dist.
  if (!(await row('src/new.ts').count())) await row('src').click()
  await sleep(400)
  await page.evaluate(() => {
    const dt = new DataTransfer()
    const src = document.querySelector('.file-row[data-rel="src/new.ts"]')
    const dst = document.querySelector('.file-row[data-rel="dist"]')
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    dst.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    dst.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  check('drag src/new.ts onto dist moves it', !!(await lib.until(async () => exists('dist/new.ts') && !exists('src/new.ts') && (await selected('dist/new.ts')), HUNG_MS)))

  // Drop from Explorer onto the root.
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.id = '__drop'
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  await page.setInputFiles('#__drop', path.join(scratch, 'from explorer.txt'))
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(document.getElementById('__drop').files[0])
    const t = document.querySelector('.file-tree')
    t.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    t.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  check('drop from Explorer copies into the project', !!(await lib.until(async () => exists('from explorer.txt') && (await selected('from explorer.txt')), HUNG_MS)))

  // A paste that ends late leaves alone a row clicked meanwhile (#641). Every folder listing takes 5 s, so the paste's
  // reload of dist is still under way when .gitignore is clicked; it goes out before the live watch's (debounced), so
  // once the copy's row is in the tree the paste has done what it does after that reload.
  await page.keyboard.press('Control+C')
  await row('dist').click()
  await app.evaluate(() => { process.env.HIVE_TEST_SLOW_IPC = 'files:list=5000' })
  await page.keyboard.press('Control+V')
  await lib.until(() => exists('dist/from explorer.txt'), HUNG_MS)
  // Checked and clicked in one go in the window: was the paste still reloading dist at the click?
  const early = await page.evaluate(() => {
    const listed = !!document.querySelector('.file-row[data-rel="dist/from explorer.txt"]')
    document.querySelector('.file-row[data-rel=".gitignore"]').click()
    return !listed
  })
  check('…a click while a paste reloads its folder comes before the paste ends', early)
  const pastedRow = await lib.until(async () => (await row('dist/from explorer.txt').count()) === 1, HUNG_MS)
  const kept = await page.locator('.file-row.selected').evaluateAll((els) => els.map((e) => e.getAttribute('data-rel')))
  check('…and the clicked row keeps the selection once the paste ends', !!pastedRow && JSON.stringify(kept) === JSON.stringify(['.gitignore']), JSON.stringify({ pastedRow: !!pastedRow, kept }))
  await app.evaluate(() => { process.env.HIVE_TEST_SLOW_IPC = '' })

  // Live update from outside Combwork.
  w('made-outside.txt', 'hi')
  await lib.until(async () => (await row('made-outside.txt').count()) === 1, 10000)
  check('file created outside Combwork appears live', (await row('made-outside.txt').count()) === 1)

  // Filter.
  await page.locator('.files-filter input').fill('util')
  // Filtered: a flat list of the matches, so the tree's other rows go.
  check('filter finds src/util.ts', !!(await lib.until(async () => (await row('src/util.ts').count()) === 1 && (await row('src/app.ts').count()) === 0, HUNG_MS)))
  await page.screenshot({ path: path.join(shots, '2-filter.png') })
  await page.locator('.files-filter input').fill('')
  await sleep(400)

  await row('src/app.ts').click().catch(() => undefined)
  await row('src').click().catch(() => undefined)
  await sleep(300)
  await row('src/app.ts').click().catch(() => undefined)
  await sleep(300)
  await page.screenshot({ path: path.join(shots, '3-details.png') })

  // Attachments tab (#387): the old .combwork/images moved into .combwork/attachments, every kind listed, filters by kind.
  await page.locator('.tab', { hasText: 'Attachments' }).click()
  await lib.until(async () => (await page.locator('.thumb').count()) === 8, 10000)
  await page.screenshot({ path: path.join(shots, '4-attachments.png') })
  check('attachments: 8, the log, Markdown, CSV and PDF too', (await page.locator('.thumb').count()) === 8)
  check('attachments: the old images folder moved to .combwork/attachments', !fs.existsSync(path.join(proj, '.combwork', 'images')) && fs.readdirSync(path.join(proj, '.combwork', 'attachments', ids[0])).length === 6, String(fs.existsSync(path.join(proj, '.combwork', 'images'))))
  const desc = await page.locator('.images-desc').innerText().catch(() => '')
  check('attachments: a line says what the tab holds', desc === "Files kept with this project's cards, and files pasted or dropped into its agents' sessions.", desc)
  check('attachments: thumbnails load', await page.locator('.thumb img').first().evaluate((i) => i.complete && i.naturalWidth > 0))
  check('attachments: archived heading', (await page.locator('.images-archived').count()) === 1)
  const filters = await page.locator('.attachment-filter').allInnerTexts()
  check('attachments: a filter for each kind there is', JSON.stringify(filters.map((f) => f.replace(/\s+/g, ' ').trim())) === JSON.stringify(['All 8', 'Images 4', 'PDFs 1', 'Text 3']), JSON.stringify(filters))
  await page.locator('.attachment-filter[data-kind="pdf"]').click()
  check('attachments: PDFs shows the PDF only', !!(await lib.until(async () => (await page.locator('.thumb').count()) === 1 && (await page.locator('.thumb[data-kind="pdf"]').count()) === 1, HUNG_MS)))
  await page.locator('.attachment-filter', { hasText: 'All' }).click()
  await lib.until(async () => (await page.locator('.thumb').count()) === 8, HUNG_MS)
  // The log opens as text in the viewer, the PDF in the PDF viewer, Markdown and CSV in their previews: each inside the
  // viewer's frame, not placed against the window.
  const inFrame = (sel) => page.evaluate((s) => {
    const el = document.querySelector(`.attachment-frame ${s}`)
    const frame = el?.closest('.attachment-frame')
    if (!el || !frame) return null
    const a = el.getBoundingClientRect()
    const b = frame.getBoundingClientRect()
    return a.width > 0 && a.height > 0 && a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1
  }, sel)
  await page.locator('.thumb[data-kind="text"]').first().click()
  check('viewer: a log shows its text', !!(await lib.until(async () => /line one/.test(await page.locator('.attachment-text').innerText({ timeout: 1000 }).catch(() => '')), HUNG_MS)))
  await page.screenshot({ path: path.join(shots, '5-viewer-text.png') })
  await page.keyboard.press('ArrowLeft')
  check('viewer: the PDF shows in the PDF viewer, inside the frame', !!(await lib.until(async () => (await inFrame('.pdf-preview')) === true, HUNG_MS)))
  // One key at a time: each waits for the viewer to show the next.
  const title = () => page.locator('.dialog-header h2').innerText({ timeout: 1000 }).catch(() => '')
  await page.keyboard.press('ArrowRight')
  await lib.until(async () => (await title()).endsWith('build.log'), HUNG_MS)
  await page.keyboard.press('ArrowRight')
  check('viewer: Markdown shows in its preview, inside the frame', !!(await lib.until(async () => (await inFrame('.md-preview')) === true && /Some notes/.test(await page.locator('.attachment-frame .md-preview').innerText().catch(() => '')), HUNG_MS)))
  await page.screenshot({ path: path.join(shots, '5-viewer-md.png') })
  await page.keyboard.press('ArrowRight')
  check('viewer: a CSV shows as its table, inside the frame', !!(await lib.until(async () => (await inFrame('.csv-preview')) === true && (await page.locator('.attachment-frame .csv-preview td', { hasText: 'beta' }).count()) === 1, HUNG_MS)))
  await page.screenshot({ path: path.join(shots, '5-viewer-csv.png') })
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.image-viewer').count()) === 0, HUNG_MS)
  await page.locator('.thumb').first().click()
  await lib.until(async () => (await page.locator('.image-viewer img').count()) === 1, HUNG_MS)
  await page.screenshot({ path: path.join(shots, '5-viewer.png') })
  await page.keyboard.press('ArrowRight')
  check('viewer navigates', !!(await lib.until(async () => (await page.locator('.dialog-header h2').innerText({ timeout: 1000 }).catch(() => '')).includes('10-00-00'), HUNG_MS)))
  await page.keyboard.press('Escape')

  // Light theme check of the Files tab.
  await page.locator('.tab', { hasText: 'Files' }).click()
  await sleep(300)
  await inv('settings:update', { appearance: { theme: 'light' } })
  await sleep(800)
  await page.screenshot({ path: path.join(shots, '6-light.png') })

  console.log(results.join('\n'))
  await app.close()
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
