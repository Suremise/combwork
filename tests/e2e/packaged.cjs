// File editor and previews, end to end in a throwaway profile. No clipboard use.
// Also the packaged app's own Node: 24.22.1 or later, CVE-2026-111497's fix (HI-1503; `about` checks the dev build's).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const userData = path.join(scratch, 'pprofile')
const ws = path.join(scratch, 'pws')
const shots = path.join(scratch, 'pshots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(shots, { recursive: true })
const proj = path.join(ws, 'demo')
const w = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true })
  fs.writeFileSync(path.join(proj, rel), data)
}
const png = lib.samplePng(400, 200)
w('README.md', [
  '---', 'title: front matter is hidden', '---',
  '# Demo project', '', 'Some **bold** text and a [link to other](docs/other.md).', '',
  '![picture](img/pic.png)', '',
  '```ts', 'export function add(a: number, b: number): number {', '  return a + b', '}', '```', '',
  '| Col A | Col B |', '|---|---|', '| 1 | 2 |', ''
].join('\n'))
w('docs/other.md', '# Other page\n\nYou followed the link.\n')
w('data.csv', 'name,qty,note\napple,3,"red, crunchy"\npear,5,"say ""hi"""\n')
w('page.html', '<html><body style="font-family:sans-serif"><h1>Hello HTML</h1><script>document.body.innerHTML="SCRIPT RAN"</script></body></html>')
w('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="50" fill="#f59e0b"/></svg>')
w('img/pic.png', png)
w('code.ts', 'export const answer = 42\n')
w('blob.bin', Buffer.from([0, 1, 2, 3, 0, 255, 0, 10]))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
const read = (rel) => fs.readFileSync(path.join(proj, rel), 'utf8')
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000

;(async () => {
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.PACKAGED_EXE, args: [], env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  // Node2Shell (CVE-2026-111497, Node's Brotli decoder): fixed in Node 24.22.1, so a packaged app on an older Electron,
  // or a stale dist, fails here (HI-1503).
  const node = await app.evaluate(() => process.versions.node)
  const atLeast = (v, min) => {
    const [a, b] = [v, min].map((x) => x.split('.').map(Number))
    const i = a.findIndex((n, k) => n !== b[k])
    return i < 0 || a[i] > b[i]
  }
  check(`the packaged app bundles Node 24.22.1 or later (CVE-2026-111497): ${node}`, atLeast(node, '24.22.1'))
  // A real PDF, made by Chromium.
  const pdf = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return Buffer.from(await win.webContents.printToPDF({})).toString('base64')
  })
  w('doc.pdf', Buffer.from(pdf, 'base64'))
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Files' }).click()
  await sleep(800)
  const row = (rel) => page.locator(`.file-row[data-rel="${rel}"]`)
  const pane = page.locator('.split-main')

  // Markdown preview.
  await row('README.md').click()
  await lib.until(async () => (await pane.locator('.md-preview h1').count()) === 1 && (await pane.locator('.md-preview code[data-colorized]').count()) === 1, 10000)
  check('md: heading rendered', (await pane.locator('.md-preview h1').innerText()) === 'Demo project')
  check('md: front matter hidden', !(await pane.locator('.md-preview').innerText()).includes('front matter'))
  check('md: code block coloured', (await pane.locator('.md-preview code[data-colorized]').count()) === 1)
  check('md: relative image loads', await pane.locator('.md-preview img').first().evaluate((i) => i.src.startsWith('hive-img:') && i.complete && i.naturalWidth > 0))
  check('md: table rendered', (await pane.locator('.md-preview table').count()) === 1)
  await page.screenshot({ path: path.join(shots, '1-md-preview.png') })

  // Split mode.
  await pane.locator('.segmented button', { hasText: 'Split' }).click()
  await lib.until(async () => (await pane.locator('.split-half .monaco').count()) === 1 && (await pane.locator('.split-half.preview-pane .md-preview').count()) === 1, 10000)
  check('md: split shows editor and preview', (await pane.locator('.split-half .monaco').count()) === 1 && (await pane.locator('.split-half.preview-pane .md-preview').count()) === 1)
  await page.screenshot({ path: path.join(shots, '2-md-split.png') })

  // Edit in split: preview follows, Ctrl+S saves.
  await pane.locator('.monaco').first().click({ position: { x: 300, y: 40 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n## Added live\n')
  check('md: preview updates while typing', !!(await lib.until(async () => (await pane.locator('.md-preview h2').allInnerTexts()).includes('Added live'), HUNG_MS)))
  check('md: dirty marker in toolbar and tree', !!(await lib.until(async () => (await pane.locator('.editor-toolbar .dirty-dot').count()) === 1 && (await row('README.md').locator('.dirty-dot').count()) === 1, HUNG_MS)))
  await page.keyboard.press('Control+S')
  check('md: Ctrl+S saves to disk', !!(await lib.until(() => read('README.md').includes('## Added live'), HUNG_MS)))
  // The marker clears once the save's reply reaches the editor, which can be after the file is on disk.
  check('md: dirty marker cleared', !!(await lib.until(async () => (await pane.locator('.editor-toolbar .dirty-dot').count()) === 0, HUNG_MS)))
  check('md: front matter kept on disk', read('README.md').startsWith('---\ntitle'))

  // Link to another markdown file opens it.
  await pane.locator('.segmented button', { hasText: 'Preview' }).click()
  await lib.until(async () => (await pane.locator('.split-half .monaco').count()) === 0, HUNG_MS)
  await pane.locator('.md-preview a', { hasText: 'link to other' }).click()
  await lib.until(async () => ((await row('docs/other.md').getAttribute('class')) ?? '').includes('selected'), 10000)
  check('md: relative link opens docs/other.md', (await row('docs/other.md').getAttribute('class')).includes('selected') && (await pane.locator('.md-preview h1').innerText()) === 'Other page')

  // Draft survives switching files.
  await row('code.ts').click()
  await lib.until(async () => (await pane.locator('.monaco .view-lines').count()) === 1, 10000)
  await pane.locator('.monaco').first().click({ position: { x: 300, y: 40 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.type('export const draft = true\n')
  // The draft is kept once the file shows as unsaved: switching files before that would lose it.
  await lib.until(async () => (await row('code.ts').locator('.dirty-dot').count()) === 1, HUNG_MS)
  await row('data.csv').click()
  await lib.until(async () => (await pane.locator('.csv-preview tbody tr').count()) === 2, 10000)
  check('csv: table with quoted fields', (await pane.locator('.csv-preview tbody tr').count()) === 2 && (await pane.locator('.csv-preview tbody tr').nth(0).innerText()).includes('red, crunchy') && (await pane.locator('.csv-preview tbody tr').nth(1).innerText()).includes('say "hi"'))
  await page.screenshot({ path: path.join(shots, '3-csv.png') })
  check('draft: unsaved file keeps its dot in the tree', (await row('code.ts').locator('.dirty-dot').count()) === 1)
  await row('code.ts').click()
  await lib.until(async () => (await pane.locator('.monaco .view-lines').innerText().catch(() => '')).replace(/\u00a0/g, ' ').includes('draft = true'), 10000)
  check('draft: edits restored when coming back', (await pane.locator('.monaco .view-lines').innerText()).replace(/ /g, ' ').includes('draft = true'))

  // Conflict: file changes on disk while edited.
  w('code.ts', 'export const answer = 43 // changed outside\n')
  await lib.until(async () => (await pane.locator('.banner', { hasText: 'changed on disk' }).count()) === 1, 10000)
  check('conflict: banner shown', (await pane.locator('.banner', { hasText: 'changed on disk' }).count()) === 1)
  await page.screenshot({ path: path.join(shots, '4-conflict.png') })
  await pane.getByRole('button', { name: 'Overwrite with mine' }).click()
  check('conflict: overwrite writes my version', !!(await lib.until(() => read('code.ts').includes('draft = true') && !read('code.ts').includes('changed outside'), HUNG_MS)))
  // The editor is clean again once the save's reply reaches it (after the file is on disk): the next step needs that.
  await lib.until(async () => (await pane.locator('.editor-toolbar .dirty-dot').count()) === 0 && (await pane.locator('.banner', { hasText: 'changed on disk' }).count()) === 0, HUNG_MS)

  // Clean file changed on disk reloads silently.
  w('code.ts', 'export const answer = 44 // reloaded\n')
  await lib.until(async () => (await pane.locator('.monaco .view-lines').innerText().catch(() => '')).includes('reloaded'), 10000)
  check('reload: clean file follows disk', (await pane.locator('.monaco .view-lines').innerText()).includes('reloaded') && (await pane.locator('.banner', { hasText: 'changed on disk' }).count()) === 0)

  // Other previews.
  await row('page.html').click()
  await lib.until(async () => ((await row('page.html').getAttribute('class')) ?? '').includes('selected') && (await pane.locator('.segmented button', { hasText: 'Preview' }).count()) === 1, HUNG_MS)
  await pane.locator('.segmented button', { hasText: 'Preview' }).click()
  await lib.until(async () => (await page.frameLocator('.html-preview').locator('h1').count()) === 1, 10000)
  const frame = page.frameLocator('.html-preview')
  check('html: rendered in sandbox, script blocked', (await frame.locator('h1').innerText()) === 'Hello HTML')
  await row('icon.svg').click()
  check('svg: rendered as image', !!(await lib.until(() => pane.locator('.image-preview img').evaluate((i) => i.complete && i.naturalWidth === 120, null, { timeout: 1000 }).catch(() => false), HUNG_MS)))
  await row('img').click()
  await lib.until(async () => (await row('img/pic.png').count()) === 1, HUNG_MS)
  await row('img/pic.png').click()
  await lib.until(async () => pane.locator('.image-preview img').evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false), 10000)
  check('png: image preview loads', await pane.locator('.image-preview img').evaluate((i) => i.complete && i.naturalWidth > 0))
  check('png: size shown', (await pane.locator('.image-size').innerText()).includes('×'))
  await row('doc.pdf').click()
  await lib.until(async () => (await pane.locator('.pdf-preview').count()) === 1, 10000)
  check('pdf: viewer frame present', (await pane.locator('.pdf-preview').count()) === 1)
  await page.screenshot({ path: path.join(shots, '5-pdf.png') })
  await row('blob.bin').click()
  check('binary: not opened as text', !!(await lib.until(async () => (await pane.innerText()).includes('binary file'), HUNG_MS)))

  // Light theme, markdown.
  await inv('settings:update', { appearance: { theme: 'light' } })
  await row('README.md').click()
  await lib.until(async () => (await pane.locator('.md-preview h1').count()) === 1 && (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', 10000)
  await page.screenshot({ path: path.join(shots, '6-md-light.png') })

  console.log(results.join('\n'))
  await app.close()
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
