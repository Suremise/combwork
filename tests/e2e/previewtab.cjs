// The Preview tab (HI-3615, design HI-3597 s8, s16 §E tests 5 and 7; SPEC §16.21): a test Combwork's project tab strip, the
// tab's header and its guarded page, through the window as the user uses it.
// 7. Off (the default): no Preview tab in the strip or in More ▾, and its command isn't offered. On with no preview
//    command: Preview is in More ▾, and the tab says "Set up a preview", its button opening Project Settings → Preview.
//    With a command: Preview is in the strip. Turned off again while shown: the Session tab instead.
// The tab: Start runs the dev server and shows its page (the stamp: Project folder · its commit); the page's own text is
// shown in the guarded view; Reload and a hard reload; Stop; the stamp says "stale" once the files change, and Restart
// starts it again from them.
// 5. Leaving and permissions, from a fixture page: window.open, a script's navigation and a meta refresh to another site
//    open nothing and leave the page where it is; Combwork's own bar names the address, and only its button opens it (in a
//    test copy written to a file, never a real browser), and only for an address the page tried; the camera, the
//    microphone, geolocation, notifications and clipboard reading are refused; a download is cancelled.
// Dev build, throwaway profile and workspace (no agent is started).
// Dev build only (#1578): Open in Browser is written to a file through a test copy's seam, and its guard read through preview:test.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

// Above the e2e lanes' ports (lanes.mjs: 47939–48128), below Windows' dynamic range.
const PORT = Number(lib.port(48302))
const HUNG_MS = lib.timing('hang.step')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

/** The fixture page: on /leave it tries to leave, asks for permissions and downloads, reporting each to its own server. */
const PAGE = `<!doctype html><html><head><title>fixture</title></head><body><h1>Preview fixture</h1><script>
const report = (name, outcome) => fetch('/report', { method: 'POST', body: JSON.stringify({ name, outcome }) }).catch(() => {})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
if (location.pathname === '/leave') (async () => {
  const w = window.open('https://example.com/opened')
  report('window.open', w ? 'window' : 'null')
  try { await navigator.mediaDevices.getUserMedia({ video: true }); report('camera', 'granted') } catch (e) { report('camera', 'refused ' + e.name) }
  try { await navigator.mediaDevices.getUserMedia({ audio: true }); report('microphone', 'granted') } catch (e) { report('microphone', 'refused ' + e.name) }
  await new Promise((r) => navigator.geolocation.getCurrentPosition(() => { report('geolocation', 'granted'); r() }, (e) => { report('geolocation', 'refused ' + e.code); r() }, { timeout: 3000 }))
  report('notifications', await Notification.requestPermission())
  try { await navigator.clipboard.readText(); report('clipboard', 'granted') } catch (e) { report('clipboard', 'refused ' + e.name) }
  const a = document.createElement('a'); a.href = '/file.bin'; a.download = 'file.bin'; document.body.appendChild(a); a.click()
  await wait(500)
  report('script navigation', 'trying')
  location.href = 'https://example.com/navigated'
  await wait(1000)
  const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=https://example.com/refreshed'; document.head.appendChild(m)
  await wait(1500)
  report('still here', location.href)
})()
</script></body></html>`

function devServer(file) {
  return [
    "const http = require('http'), fs = require('fs')",
    `const page = ${JSON.stringify(PAGE)}, out = ${JSON.stringify(file)}`,
    "http.createServer((req, res) => {",
    "  if (req.url.startsWith('/report')) { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { fs.appendFileSync(out, b + '\\n'); res.end('ok') }); return }",
    "  if (req.url.startsWith('/file.bin')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=file.bin' }); return res.end('data') }",
    "  fs.appendFileSync(out, JSON.stringify({ name: 'served', outcome: req.url }) + '\\n')",
    "  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)",
    "}).listen(Number(process.env.PORT), '127.0.0.1')",
    ''
  ].join('\n')
}

;(async () => {
  const fx = q.queueProject('previewtab')
  q.prepare(fx)
  const results = path.join(fx.tools, 'results.jsonl')
  const opened = path.join(fx.tools, 'opened.txt')
  const server = path.join(fx.tools, 'server.js')
  fs.writeFileSync(server, devServer(results))
  const lines = () => (fs.existsSync(results) ? fs.readFileSync(results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true, env: { CW_TEST_PREVIEW_OPENED: opened } })
  try {
    const { page, inv, app } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    const command = (id) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'menu-command', command: id, args: [] })
    await page.getByText('alpha', { exact: true }).first().click()
    const stripTab = page.locator('.tabs .tab:not(.tab-more)', { hasText: 'Preview' })
    /** More ▾'s items, read with its menu open (then closed). */
    const moreItems = async () => {
      await page.locator('.tabs .tab-more').click()
      await until(async () => (await page.locator('.menu .menu-item').count()) > 0, HUNG_MS)
      const items = await page.locator('.menu .menu-item').allInnerTexts()
      await until(async () => {
        if (await page.locator('.menu').count()) await page.keyboard.press('Escape')
        return (await page.locator('.menu').count()) === 0
      }, HUNG_MS)
      return items.join('|')
    }

    // --- 7. Off: nowhere.
    check('off: no Preview tab in the strip', (await stripTab.count()) === 0)
    check('off: …nor in More ▾', !/Preview/.test(await moreItems()))

    // --- On, no command: in More ▾, "Set up a preview".
    await inv('advanced:set', 'cw.preview.enabled', true)
    check('on with no command: Preview is in More ▾, not the strip', !!(await until(async () => (await stripTab.count()) === 0 && /Preview/.test(await moreItems()), HUNG_MS)))
    await command('project.tab.preview')
    const setup = page.locator('[data-preview="setup"]')
    check('…its tab says "Set up a preview"', !!(await until(async () => (await setup.count()) === 1 && /Set up a preview/.test(await setup.innerText()), HUNG_MS)))
    await setup.locator('[data-action="preview-settings"]').click()
    check('…and its button opens Project Settings → Preview', !!(await until(async () => (await page.locator('[data-setting="preview"]').count()) === 1, HUNG_MS)))

    // --- With a command: in the strip.
    await inv('preview:setConfig', fx.alpha, { command: `node "${server}"` })
    await inv('workspace:refresh')
    check('with a command: Preview is in the strip', !!(await until(async () => (await stripTab.count()) === 1, HUNG_MS)), JSON.stringify([await page.locator('.tabs .tab').allTextContents(), (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === fx.alpha.toLowerCase())?.config.preview]))
    await stripTab.click()
    const tabEl = page.locator('.preview-tab')
    check('the tab shows Start, the command it runs', !!(await until(async () => (await tabEl.locator('[data-action="preview-start"]').count()) === 1 && (await tabEl.locator('[data-preview="status"]').innerText()).includes('server.js'), HUNG_MS)))

    // --- Start: its page shown, the stamp.
    await tabEl.locator('[data-action="preview-start"]').click()
    const head = lib.git(fx.alpha, ['rev-parse', 'HEAD']).trim()
    const stamp = tabEl.locator('[data-preview="stamp"]')
    check('Start: the stamp names the place and its commit', !!(await until(async () => (await stamp.count()) === 1 && (await stamp.innerText()).includes(`Project folder · ${head.slice(0, 7)}`), HUNG_MS)), await stamp.innerText().catch(() => ''))
    const running = async () => (await inv('preview:list', fx.alpha)).find((v) => v.state === 'running')
    const v = await until(running, HUNG_MS)
    check('…its page is shown in the guarded view, served by its dev server', !!v && !!(await until(async () => (await inv('preview:test', { op: 'shown', id: v.id })).shown && lines().some((l) => l.name === 'served' && l.outcome === '/'), HUNG_MS)))
    await page.mouse.move(5, 5)
    await page.screenshot({ path: path.join(fx.shots, 'previewtab-1-running.png') })
    check('…and the page itself is drawn in its view (its own capture)', (await inv('preview:test', { op: 'capture', id: v.id, file: path.join(fx.shots, 'previewtab-1-page.png') })) === true)
    const served = () => lines().filter((l) => l.name === 'served').length
    let n = served()
    await tabEl.locator('button[aria-label="Reload"]').click()
    check('Reload loads the page again', !!(await until(() => served() > n, HUNG_MS)))
    n = served()
    await tabEl.locator('button[aria-label="Reload, bypassing the cache"]').click()
    check('…and so does a hard reload', !!(await until(() => served() > n, HUNG_MS)))

    // --- Stale, and Restart.
    fs.writeFileSync(path.join(fx.alpha, 'a.txt'), 'changed\n')
    const stale = tabEl.locator('[data-preview="stale"]')
    check('its files changed: the stamp says stale', !!(await until(async () => (await stale.count()) === 1, HUNG_MS)))
    await stale.locator('button').click()
    check('…Restart starts it again from them: the commit and its files\' tree', !!(await until(async () => / \+ tree [0-9a-f]{7}/.test(await stamp.innerText().catch(() => '')) && (await stale.count()) === 0, HUNG_MS)), await stamp.innerText().catch(() => ''))

    // --- 5. Leaving and permissions.
    await inv('preview:stop', fx.alpha)
    await inv('preview:setConfig', fx.alpha, { command: `node "${server}"`, path: '/leave' })
    await inv('workspace:refresh')
    await until(async () => (await tabEl.locator('[data-action="preview-start"]').count()) === 1, HUNG_MS)
    await tabEl.locator('[data-action="preview-start"]').click()
    const w = await until(running, HUNG_MS)
    const said = () => Object.fromEntries(lines().filter((l) => l.name !== 'served').map((l) => [l.name, l.outcome]))
    check('the leaving page ran to its end', !!(await until(() => !!said()['still here'], HUNG_MS)), JSON.stringify(said()))
    const s = said()
    check('window.open opened nothing (no window, no page)', s['window.open'] === 'null' && (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, s['window.open'])
    check("a script's navigation and a meta refresh left the page where it is", (s['still here'] ?? '').endsWith('/leave'), s['still here'])
    check('the camera and the microphone are refused', (s.camera ?? '').startsWith('refused') && (s.microphone ?? '').startsWith('refused'), JSON.stringify([s.camera, s.microphone]))
    check('geolocation, notifications and clipboard reading are refused', (s.geolocation ?? '').startsWith('refused') && s.notifications === 'denied' && (s.clipboard ?? '').startsWith('refused'), JSON.stringify([s.geolocation, s.notifications, s.clipboard]))
    const refusals = (await inv('preview:test', { op: 'refusals', id: w.id })) ?? []
    check('the download is cancelled', refusals.some((r) => r.layer === 'download' && /file\.bin/.test(r.url)), JSON.stringify(refusals))
    check('…and the permissions were refused by the partition', refusals.filter((r) => r.layer === 'permission').length >= 3, JSON.stringify(refusals.filter((r) => r.layer === 'permission')))
    const tried = await inv('preview:test', { op: 'tried', id: w.id })
    check('Combwork noted each address it tried: the new window, the navigation, the refresh', ['https://example.com/opened', 'https://example.com/navigated', 'https://example.com/refreshed'].every((u) => tried.includes(u)), JSON.stringify(tried))
    const bar = tabEl.locator('[data-preview="tried"]')
    check("Combwork's own bar names the address", !!(await until(async () => (await bar.count()) === 1 && /The page tried to open https:\/\/example\.com\//.test(await bar.innerText()), HUNG_MS)))
    await page.screenshot({ path: path.join(fx.shots, 'previewtab-2-tried.png') })
    check('nothing was opened before the button', !fs.existsSync(opened))
    check('an address the page never tried is refused', (await inv('preview:openTried', w.id, 'https://evil.example/')) === false && !fs.existsSync(opened))
    await bar.locator('[data-action="preview-open-browser"]').click()
    check('…its button opens the address (a test copy writes it down instead of a browser)', !!(await until(() => fs.existsSync(opened) && /^https:\/\/example\.com\/(opened|navigated|refreshed)\n$/.test(fs.readFileSync(opened, 'utf8')), HUNG_MS)), fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8') : 'none')

    // --- Stop from the tab.
    await tabEl.locator('[data-action="preview-stop"]').click()
    check('Stop stops it: the tab says so', !!(await until(async () => (await tabEl.locator('[data-preview="status"]').count()) === 1 && /Stopped\./.test(await tabEl.locator('[data-preview="status"]').innerText()), HUNG_MS)))

    // --- 7. Turned off again while it is shown: the Session tab instead, and no Preview tab.
    await stripTab.click()
    await inv('advanced:set', 'cw.preview.enabled', false)
    check('off again: the Preview tab goes, the Session tab is shown', !!(await until(async () => (await stripTab.count()) === 0 && (await page.locator('.tabs .tab.active', { hasText: 'Session' }).count()) === 1, HUNG_MS)))
    check('…and More ▾ has none', !/Preview/.test(await moreItems()))
  } catch (e) {
    check('the run went through', false, e?.stack ?? String(e))
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
