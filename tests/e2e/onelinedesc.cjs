// One-line descriptions in side-panel lists (HI-2527): each stays on one line, cut with "…", and hovering a cut one
// shows its full text in the app's tooltip; one that fits shows none. Modes, Skills, Templates and Dialects, whose
// rows a new profile has; the MCP lists use the same OneLineDesc.
// Throwaway profile and workspace; no sessions started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'onelinedesc-profile')
const ws = path.join(scratch, 'onelinedesc-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
;(async () => {
  lib.enableProviders(userData)
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ HIVE_USER_DATA: userData }) })
  try {
    const page = await app.firstWindow()
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.until(async () => (await page.locator('.project-row').count()) === 1, HUNG_MS)

    // The side panel at its narrowest (200 px), dragged by its edge: descriptions are cut there.
    const edge = await page.locator('.sidebar-resizer').boundingBox()
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 300)
    await page.mouse.down()
    for (let x = edge.x; x > edge.x - 120; x -= 10) await page.mouse.move(x, edge.y + 300)
    await page.mouse.up()
    const width = await page.locator('.sidebar').evaluate((e) => Math.round(e.getBoundingClientRect().width))
    check('the side panel is at its narrowest', width === 200, `${width}`)

    const lists = [
      { name: 'Modes', button: 'Assistant', rows: '.sidebar .mode-row' },
      { name: 'Skills', button: 'Skills', rows: '.sidebar .skill-row' },
      { name: 'Templates', button: 'Templates', rows: '.sidebar .template-row' },
      { name: 'Dialects', button: 'Dialects', rows: '.sidebar .dialect-row' }
    ]
    let shot = false
    for (const l of lists) {
      await page.locator(`.activitybar .activity-btn[aria-label="${l.button}"]`).click()
      const descs = page.locator(`${l.rows} .one-line-desc`)
      await lib.until(async () => (await descs.count()) > 0, HUNG_MS)
      const all = await descs.evaluateAll((els) => els.map((e) => ({ cut: e.scrollWidth > e.clientWidth + 1, text: e.textContent, oneLine: e.getBoundingClientRect().height < 20 })))
      check(`${l.name}: descriptions stay on one line`, all.length > 0 && all.every((d) => d.oneLine), `${all.length} rows`)
      const i = all.findIndex((d) => d.cut)
      if (i < 0) {
        check(`${l.name}: a description is cut at 200 px`, false, JSON.stringify(all.map((d) => d.text)))
        continue
      }
      const full = all[i].text
      const tip = await lib.hoverTip(page, descs.nth(i), (t) => t === full)
      check(`${l.name}: hovering a cut description shows it in full`, tip === full, JSON.stringify({ tip, full }))
      if (!shot) {
        await page.screenshot({ path: path.join(scratch, `onelinedesc-${l.name.toLowerCase()}-tip.png`) })
        shot = true
      }
      const j = all.findIndex((d) => !d.cut && d.text)
      if (j >= 0) {
        await page.mouse.move(5, 5)
        await descs.nth(j).hover()
        // A tip would show after its delay: wait until one does or the bound passes, then say none came.
        const came = await lib.until(async () => (await page.locator('.tip:visible').count()) > 0, 1500)
        check(`${l.name}: one that fits shows no tooltip`, !came)
      }
    }
  } catch (e) {
    fail++
    console.log('FAIL', e.stack || e)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
