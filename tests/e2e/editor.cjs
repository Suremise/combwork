// File editor and previews, end to end in a throwaway profile. No clipboard use.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const scratch = lib.WORK
const userData = path.join(scratch, 'eprofile')
const ws = path.join(scratch, 'ews')
const shots = path.join(scratch, 'eshots')
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
// Windows-1252 "café\r\n" (HI-2331): not UTF-8, so never opened for editing (a save would write U+FFFD over E9).
const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a])
w('latin1.txt', latin1)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
const read = (rel) => fs.readFileSync(path.join(proj, rel), 'utf8')
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000

;(async () => {
  const env = lib.hiveEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  // A real PDF, made by Chromium.
  const pdf = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return Buffer.from(await win.webContents.printToPDF({})).toString('base64')
  })
  w('doc.pdf', Buffer.from(pdf, 'base64'))
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
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
  check('md: relative image loads', await pane.locator('.md-preview img').first().evaluate((i) => i.src.startsWith('combwork-img:') && i.complete && i.naturalWidth > 0))
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
  check('md: Ctrl+S saves to disk', !!(await lib.until(() => read('README.md').includes('## Added live'), 10000)))
  // The marker clears once the save's reply reaches the editor, which can be after the file is on disk.
  check('md: dirty marker cleared', !!(await lib.until(async () => (await pane.locator('.editor-toolbar .dirty-dot').count()) === 0, 10000)))
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
  // What Monaco did around the hover below, logged only if it fails (HI-2214): the editor's own events from its
  // creation, its target under the pointer and the hover's steps. Through the renderer's own Monaco module, no app hook.
  const monacoChunk = fs.readdirSync(path.join(lib.ROOT, 'out', 'renderer', 'assets')).find((n) => /^monaco-.*\.js$/.test(n))
  await page.evaluate(async (chunk) => {
    try {
      const mod = await import(new URL(`./assets/${chunk}`, location.href).href)
      const t0 = performance.now()
      const trace = (window.__hoverTrace = { mod, log: [] })
      trace.L = (...a) => trace.log.push(`${Math.round(performance.now() - t0)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`)
      trace.created = mod.e.onDidCreateEditor((ed) => {
        const id = `ed${ed.getId().split(':').pop()}`
        trace.L(id, 'created')
        ed.onDidChangeModel(() => trace.L(id, 'model', ed.getModel()?.getLineCount()))
        ed.onDidLayoutChange((l) => trace.L(id, 'layout', l.width, l.height))
        ed.onDidScrollChange((e) => (e.scrollTopChanged || e.scrollLeftChanged) && trace.L(id, 'scroll', e.scrollTop, e.scrollLeft))
        ed.onDidChangeModelContent(() => trace.L(id, 'content'))
        ed.onDidDispose(() => trace.L(id, 'disposed'))
      })
    } catch (e) {
      window.__hoverTrace = { log: [`no trace: ${e.message}`] }
    }
  }, monacoChunk)
  await row('code.ts').click()
  await lib.until(async () => (await pane.locator('.monaco .view-lines').innerText().catch(() => '')).replace(/\u00a0/g, ' ').includes('draft = true'), 10000)
  check('draft: edits restored when coming back', (await pane.locator('.monaco .view-lines').innerText()).replace(/ /g, ' ').includes('draft = true'))
  // A hover's Markdown goes through Monaco's sanitiser (domSanitize: Combwork's DOMPurify since #1141): the type of
  // `answer`, rendered.
  const hoverText = () => page.locator('.monaco-hover:not(.hidden) .monaco-hover-content').first().innerText().catch(() => '')
  // Where `answer` is drawn in its line (the editor's spans split a line as its tokens fall).
  const word = await pane.locator('.monaco .view-lines').first().evaluate((lines) => {
    const walk = document.createTreeWalker(lines, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.textContent.indexOf('answer')
      if (at < 0) continue
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + 'answer'.length)
      const b = r.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }
    return null
  })
  await page.evaluate((at) => {
    const trace = window.__hoverTrace
    if (!trace?.mod) return
    const { mod, L } = trace
    L('test: moving to', at)
    const ed = mod.e.getEditors().find((e) => e.getDomNode()?.isConnected && e.getModel()?.getValue().includes('draft = true'))
    if (!ed) return L('no editor with the draft', mod.e.getEditors().length)
    const target = (t) => t && { type: t.type, pos: t.position, word: t.position && ed.getModel().getWordAtPosition(t.position)?.word }
    L(`ed${ed.getId().split(':').pop()} target at the pointer`, at && target(ed.getTargetAtClientPoint(at.x, at.y)))
    ed.onMouseMove((e) => L('mousemove', target(e.target)))
    ed.onMouseLeave(() => L('mouseleave'))
    ed.onMouseDown(() => L('mousedown'))
    ed.onKeyDown((e) => L('keydown', e.code))
    // The hover's steps, by Monaco 0.57's names (one renamed in an update just isn't logged).
    const wrap = (o, name, tag = name) => {
      const f = o?.[name]
      if (typeof f === 'function') o[name] = function (...a) { const r = f.apply(this, a); L(tag, typeof r === 'boolean' ? r : ''); return r }
    }
    const c = ed.getContribution('editor.contrib.contentHover')
    L('hover controller', !!c)
    for (const m of ['hideContentHover', '_cancelScheduler']) wrap(c, m)
    const make = c?._getOrCreateContentWidget
    if (typeof make === 'function') {
      c._getOrCreateContentWidget = function () {
        const widget = make.apply(this)
        if (!widget.__traced) {
          widget.__traced = true
          for (const m of ['showsOrWillShow', '_setCurrentResult', '_showHover', '_hideHover']) wrap(widget, m, `widget ${m}`)
        }
        return widget
      }
    }
    trace.provider = mod.l.registerHoverProvider('typescript', { provideHover: (m, p) => { L('providers asked', p); return null } })
  }, word)
  if (word) await page.mouse.move(word.x, word.y)
  const hoverShown = !!(await lib.until(async () => /answer/.test(await hoverText()), HUNG_MS))
  check("hover: Monaco's Markdown hover renders (its sanitiser)", hoverShown)
  const hoverTrace = await page.evaluate(() => { const t = window.__hoverTrace; t?.provider?.dispose(); t?.created?.dispose(); return t?.log ?? ['no trace'] })
  if (!hoverShown) {
    // HI-2214 evidence: where the pointer was, what is under it now, and Monaco's hover widgets.
    const state = await page.evaluate((at) => {
      const now = (() => {
        const lines = document.querySelector('.monaco .view-lines')
        if (!lines) return null
        const walk = document.createTreeWalker(lines, NodeFilter.SHOW_TEXT)
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const i = n.textContent.indexOf('answer')
          if (i < 0) continue
          const r = document.createRange()
          r.setStart(n, i)
          r.setEnd(n, i + 6)
          const b = r.getBoundingClientRect()
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
        }
        return null
      })()
      const under = at ? document.elementFromPoint(at.x, at.y) : null
      const chain = []
      for (let e = under; e && chain.length < 6; e = e.parentElement) chain.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`)
      const hovers = [...document.querySelectorAll('.monaco-hover')].map((h) => ({ cls: h.className, text: h.innerText.slice(0, 120), shown: getComputedStyle(h).display !== 'none' }))
      return { at, now, under: chain, hovers, editors: document.querySelectorAll('.monaco').length, lines: document.querySelector('.monaco .view-lines')?.innerText.slice(0, 120) }
    }, word)
    results.push(`INFO hover evidence (HI-2214): ${JSON.stringify(state)}`)
    results.push(`INFO hover trace (HI-2214): ${hoverTrace.join(' | ')}`)
    await page.screenshot({ path: path.join(shots, '3b-hover-failed.png') })
  }
  await page.mouse.move(5, 5)

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

  // The editor's right-click menu (#1102): Monaco draws it in a shadow root, where its theme's colours didn't reach
  // (black text on no surface). It has a surface, a border and readable entries, hovered too, in both themes.
  /** The open menu's colours: its surface, border, and an entry's text and background, with the hovered entry's. */
  const editorMenu = () =>
    page.evaluate(() => {
      const root = [...document.querySelectorAll('.shadow-root-host')].map((h) => h.shadowRoot).find((r) => r?.querySelector('.monaco-menu .action-label'))
      if (!root) return null
      const menu = root.querySelector('.monaco-menu')
      const surface = getComputedStyle(menu.closest('.monaco-scrollable-element') ?? menu).backgroundColor
      const items = [...root.querySelectorAll('.action-menu-item')]
      const item = (e) => ({ fg: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor })
      return { surface, border: getComputedStyle(menu).borderTopWidth, plain: items.map(item).find((i) => i.bg === 'rgba(0, 0, 0, 0)'), hovered: items.filter((e) => e.matches(':hover')).map(item)[0] }
    })
  const rgb = (c) => (c?.match(/[\d.]+/g) ?? []).map(Number)
  const contrast = (a, b) => {
    const lum = ([r, g, bl]) => [r, g, bl].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
    const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
  }
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme, HUNG_MS)
    const box = await pane.locator('.monaco .view-lines').boundingBox()
    await page.mouse.click(box.x + 120, box.y + 8, { button: 'right' })
    const shown = await lib.until(editorMenu, HUNG_MS)
    const opaque = !!shown && rgb(shown.surface).length === 3
    check(`editor menu (${theme}): a surface and a border`, opaque && parseFloat(shown.border) >= 1)
    check(`editor menu (${theme}): entries readable`, opaque && !!shown.plain && contrast(shown.plain.fg, shown.surface) >= 4.5)
    // Hovered entries are filled, like Combwork's own menus.
    const entry = await page.evaluate(() => {
      const root = [...document.querySelectorAll('.shadow-root-host')].map((h) => h.shadowRoot).find((r) => r?.querySelector('.monaco-menu .action-label'))
      const r = root?.querySelector('.action-menu-item')?.getBoundingClientRect()
      return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    if (entry) await page.mouse.move(entry.x, entry.y)
    const hovered = await lib.until(async () => { const m = await editorMenu(); return m?.hovered && rgb(m.hovered.bg).length === 3 ? m.hovered : null }, HUNG_MS)
    check(`editor menu (${theme}): hovered entry filled and readable`, !!hovered && contrast(hovered.fg, hovered.bg) >= 4.5)
    await page.screenshot({ path: path.join(shots, `5b-editor-menu-${theme}.png`) })
    await page.keyboard.press('Escape')
    await lib.until(async () => !(await editorMenu()), HUNG_MS)
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })

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
  await row('latin1.txt').click()
  check('not UTF-8: refused with Open in Default App, no editor', !!(await lib.until(async () => (await pane.innerText()).includes("isn't UTF-8 text") && (await pane.locator('.monaco-editor').count()) === 0, HUNG_MS)))
  check('not UTF-8: the file is untouched', fs.readFileSync(path.join(proj, 'latin1.txt')).equals(latin1))
  await page.screenshot({ path: path.join(shots, '5c-not-utf8.png') })

  // Light theme, markdown.
  await inv('settings:update', { appearance: { theme: 'light' } })
  await row('README.md').click()
  await lib.until(async () => (await pane.locator('.md-preview h1').count()) === 1 && (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', 10000)
  await page.screenshot({ path: path.join(shots, '6-md-light.png') })

  // A narrow file pane (#814): the toolbar drops its labels rather than push Save out of sight. The mode buttons and
  // Save become icons, named for screen readers, and still work; wider again, the labels come back.
  const bar = pane.locator('.editor-toolbar')
  /** The toolbar's state: compact or not, overflowing or not, Save wholly inside it, and the file's name shown. */
  const toolbar = () =>
    bar.evaluate((t) => {
      const box = t.getBoundingClientRect()
      const save = [...t.querySelectorAll('button.primary')].pop()?.getBoundingClientRect()
      return {
        compact: t.classList.contains('compact'),
        overflows: t.scrollWidth > t.clientWidth,
        saveInside: !!save && save.width > 0 && save.left >= box.left - 0.5 && save.right <= box.right + 0.5,
        name: t.querySelector('.path strong')?.getBoundingClientRect().width ?? 0,
        modes: [...t.querySelectorAll('.segmented button')].map((m) => m.getAttribute('aria-label') ?? m.textContent.trim())
      }
    })
  for (const theme of ['light', 'dark']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.fitWindow(app, page, { width: 900, height: 700 })
    const narrow = await lib.until(async () => { const t = await toolbar(); return t.compact ? t : null }, HUNG_MS)
    check(`narrow pane (${theme}): toolbar drops its labels`, !!narrow)
    check(`narrow pane (${theme}): Save in view, nothing overflows, the name shown`, !!narrow && narrow.saveInside && !narrow.overflows && narrow.name > 0)
    await page.screenshot({ path: path.join(shots, `7-narrow-toolbar-${theme}.png`) })
  }
  check('narrow pane: mode buttons keep their names', JSON.stringify((await toolbar()).modes) === JSON.stringify(['Preview', 'Split', 'Edit']))
  await bar.getByRole('button', { name: 'Edit', exact: true }).click()
  check('narrow pane: an icon-only mode button still switches', !!(await lib.until(async () => (await pane.locator('.monaco').count()) === 1, HUNG_MS)))
  // The narrow editor's left edge: further right is the side panels' rails.
  await pane.locator('.monaco').first().click({ position: { x: 30, y: 20 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nnarrow\n')
  await bar.getByRole('button', { name: 'Save', exact: true }).click()
  check('narrow pane: the icon-only Save saves', !!(await lib.until(() => read('README.md').includes('narrow'), HUNG_MS)))
  await lib.fitWindow(app, page, { width: 1700, height: 900 })
  const wide = await lib.until(async () => { const t = await toolbar(); return !t.compact ? t : null }, HUNG_MS)
  check('wide pane: labels back', !!wide && wide.saveInside && !wide.overflows && (await bar.locator('.segmented button', { hasText: 'Split' }).count()) === 1)

  console.log(results.join('\n'))
  await app.close()
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
