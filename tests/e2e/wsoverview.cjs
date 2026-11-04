// Workspace Overview: totals across projects for a period, the table by project, the stacked chart (a tile a day),
// the board strip and the hidden-project note; in a narrow window the page doesn't scroll sideways (its period buttons
// wrap, #252) while the table keeps its own scroll, down to a few dozen pixels of page beside the Assistant (#269). Transcripts are Hive backups (.combwork/sessions) dated relative to today; no
// agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'wsoverview-profile')
const ws = path.join(lib.WORK, 'wsoverview-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
lib.enableProviders(userData)

const day = 86_400_000
let n = 0
/** A project with one session: a request on each of the given days ago, with this many output tokens each. */
function project(name, requests) {
  const dir = path.join(ws, name, '.combwork', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const id = `55555555-aaaa-bbbb-cccc-${String(++n).padStart(12, '0')}`
  const lines = []
  let last = 0
  for (const [daysAgo, out] of requests) {
    const t = Date.now() - daysAgo * day
    last = Math.max(last, t)
    const at = new Date(t).toISOString()
    lines.push({ type: 'user', timestamp: at, message: { role: 'user', content: 'Go' } })
    lines.push({ type: 'assistant', requestId: `${id}-${daysAgo}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: out } } })
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const at = new Date(last).toISOString()
  fs.writeFileSync(path.join(ws, name, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id, agent: 'claude-code', name: `${name} work`, createdAt: at, lastActiveAt: at, archived: false }] }))
}
// 7 days: alpha 2,410 (today and 3 days ago), beta 2,105 (today); gamma only 20 days ago (5,105).
project('alpha', [[0, 50], [3, 150]])
project('beta', [[0, 1000]])
project('gamma', [[20, 4000]])
project('delta', [[0, 99999]])

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` (${extra})` : ''}`)
}

;(async () => {
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 950 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  // delta is hidden: left out, with a note.
  await inv('project:remove', path.join(ws, 'delta'), 'hide')
  await inv('tasks:create', { title: 'Plan', project: 'alpha' })
  await inv('tasks:create', { title: 'Check', project: 'beta', column: 'review' })

  await page.keyboard.press('Control+Shift+O')
  const head = page.locator('h1', { hasText: 'Workspace Overview' })
  check('Ctrl+Shift+O opens the Workspace Overview', !!(await until(async () => (await head.count()) === 1, HUNG_MS)))
  const rows = page.locator('.ws-projects tbody tr')
  check('it lists each project and not the hidden one', !!(await until(async () => (await rows.count()) === 3, HUNG_MS)), String(await rows.count()))
  const names = async () => (await rows.locator('td:first-child').allInnerTexts()).map((s) => s.trim())
  check('7 days is the default, biggest first', JSON.stringify(await names()) === JSON.stringify(['alpha', 'beta', 'gamma']), JSON.stringify(await names()))
  const tokens = page.locator('.card', { hasText: 'Tokens' }).first().locator('.value')
  check('the summary adds up every project in the period', (await tokens.innerText()) === '4.5k', await tokens.innerText())
  check('the chart is stacked by project, with a legend', JSON.stringify(await page.locator('.stack-legend > span').allInnerTexts().then((x) => x.map((s) => s.trim()))) === JSON.stringify(['alpha', 'beta']), JSON.stringify(await page.locator('.stack-legend > span').allInnerTexts()))
  // Every day is a tile of its own (as in the Performance chart), a day without tokens too: the same visible background.
  await page.mouse.move(5, 5)
  const tiles = await page.locator('.daily-chart:visible .daily-col').evaluateAll((cols) => cols.map((c) => ({ bg: getComputedStyle(c).backgroundColor, empty: !c.querySelector('.stack-part'), w: c.getBoundingClientRect().width })))
  check('each of the 7 days is a tile with the same visible background, empty days too', tiles.length === 7 && tiles.some((t) => t.empty) && tiles.every((t) => t.bg === tiles[0].bg && t.w > 0) && !/rgba\(0, 0, 0, 0\)|transparent/.test(tiles[0].bg), JSON.stringify(tiles))
  check('the hidden project is noted', (await page.locator('.hint', { hasText: "1 hidden or removed project isn't counted" }).count()) === 1)
  check('the board strip shows the cards', /1\s*Todo/.test(await page.locator('.board-strip').innerText()) && /1\s*Waiting for review/.test(await page.locator('.board-strip').innerText()), await page.locator('.board-strip').innerText())
  check('the sidebar lists the projects', (await page.locator('.sidebar .row', { hasText: 'gamma' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'wsoverview.png') })

  await page.locator('.segmented button', { hasText: 'All time' }).click()
  check('All time counts older work too', !!(await until(async () => (await tokens.innerText()) === '9.6k', HUNG_MS)), await tokens.innerText())
  check('and re-sorts the table', !!(await until(async () => (await names())[0] === 'gamma', HUNG_MS)), JSON.stringify(await names()))
  await page.locator('.ws-projects th button', { hasText: 'Project' }).click()
  check('a column header sorts by it', JSON.stringify(await names()) === JSON.stringify(['alpha', 'beta', 'gamma']), JSON.stringify(await names()))

  // Narrow (#252): the sidebar open, at 620 px and at 125% zoom. The page fits its width (the period buttons wrap under
  // the title); the table by project still scrolls inside itself.
  const fits = () =>
    page.evaluate(() => {
      const scroller = document.querySelector('.overview-head').closest('.scroll-page')
      const box = scroller.getBoundingClientRect()
      const right = box.left + scroller.clientWidth
      const seg = document.querySelector('.overview-head .segmented').getBoundingClientRect()
      // Every control and label inside the page, its text whole (#269): the board strip, the period buttons, the cards' titles.
      const controls = [...scroller.querySelectorAll('.board-strip-item, .overview-head .segmented button, .card h3, .overview-head .section')]
      const clipped = controls.filter((el) => {
        const r = el.getBoundingClientRect()
        return r.left < box.left - 0.5 || r.right > right + 0.5 || el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
      })
      return {
        page: scroller.scrollWidth <= scroller.clientWidth + 1,
        width: scroller.clientWidth,
        buttons: seg.right <= right + 0.5 && seg.left >= box.left,
        clipped: clipped.map((el) => el.textContent.trim().slice(0, 20)),
        table: !!document.querySelector('.ws-projects .table-wrap')
      }
    })
  // Extremes (#269): 620 px at 125% (about 100 px of page), in both themes, and the Assistant's panel open on either
  // side at 820 px (under 50 px of page). Nothing is clipped, and a period button still works.
  const assistantOpen = () => page.evaluate(() => !!document.querySelector('.assistant-panel'))
  const setAssistant = async (side) => {
    if (side) await inv('settings:update', { assistant: { panelSide: side } })
    if (!!side !== (await assistantOpen())) await page.keyboard.press('Control+Alt+I')
    await until(async () => !!side === (await assistantOpen()), HUNG_MS)
  }
  // HI-1696: and the narrowest window (900 px) at 150%, which leaves 600 px of window in all.
  for (const [width, zoom, theme, side] of [[620, 1, 'dark', null], [760, 1.25, 'dark', null], [620, 1.25, 'dark', null], [620, 1.25, 'light', null], [900, 1.5, 'dark', null], [820, 1, 'dark', 'right'], [820, 1, 'light', 'left']]) {
    await inv('settings:update', { appearance: { theme } })
    await setAssistant(side)
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await lib.fitWindow(app, page, { width, height: 900 })
    const label = `${width} px at ${zoom * 100}%${side ? `, the Assistant on the ${side}` : ''} (${theme})`
    const f = await until(async () => {
      const x = await fits()
      return x.page && x.buttons && !x.clipped.length ? x : null
    }, HUNG_MS)
    check(`${label}: the page doesn't scroll sideways, its period buttons inside it, no label clipped`, !!f, JSON.stringify(await fits()))
    check(`${label}: …the table keeps its own scroll`, (await fits()).table)
    await page.screenshot({ path: path.join(lib.WORK, `wsoverview-${width}-${zoom * 100}${side ? `-${side}` : ''}-${theme}.png`) })
    if (side === 'left') {
      // In under 50 px, a period is still chosen with its button.
      await page.locator('.overview-head .segmented button', { hasText: '30 days' }).click()
      check(`${label}: a period button still works`, !!(await until(async () => (await page.locator('.overview-head .segmented button.active').innerText()).trim() === '30 days', HUNG_MS)))
      await page.locator('.overview-head .segmented button', { hasText: 'All time' }).click()
    }
  }
  await setAssistant(null)
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await lib.fitWindow(app, page, { width: 1400, height: 950 })

  await rows.filter({ hasText: 'beta' }).click()
  const opened = await until(async () => (await page.locator('.tab.active', { hasText: 'Overview' }).count()) === 1 && (await page.locator('.project-header, .project-title').first().innerText().catch(() => '')).includes('beta'), 5000)
  check("a project's row opens its Overview", !!opened)
  await page.screenshot({ path: path.join(lib.WORK, 'wsoverview-project.png') })

  // The project Overview at the same extremes (#307): beta's most recent session has data, and its details table
  // (model, version, started, last activity) scrolls inside itself, so the page doesn't widen; scrolled, it shows all.
  check("the project Overview shows the session's details", !!(await until(async () => (await page.locator('.session-meta td', { hasText: 'Last activity' }).count()) === 1, 5000)))
  const projectFits = () =>
    page.evaluate(() => {
      const meta = document.querySelector('.session-meta')
      const scroller = meta.closest('.scroll-page')
      const box = scroller.getBoundingClientRect()
      const right = box.left + scroller.clientWidth
      const seg = document.querySelector('.overview-page .overview-head .segmented').getBoundingClientRect()
      meta.scrollLeft = meta.scrollWidth
      const table = meta.querySelector('table').getBoundingClientRect()
      const wrap = meta.getBoundingClientRect()
      const reached = table.right <= wrap.right + 1
      meta.scrollLeft = 0
      // Its labels stay whole (one line each), so a table wider than the page scrolls rather than breaking them.
      const lines = (td) => {
        const r = document.createRange()
        r.selectNodeContents(td)
        return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size
      }
      const labels = [...meta.querySelectorAll('td:first-child')]
      return {
        page: scroller.scrollWidth <= scroller.clientWidth + 1,
        width: scroller.clientWidth,
        own: getComputedStyle(meta).overflowX === 'auto' && wrap.right <= right + 0.5,
        whole: labels.every((td) => lines(td) === 1),
        scrolls: meta.scrollWidth > meta.clientWidth + 1,
        reached,
        buttons: seg.right <= right + 0.5 && seg.left >= box.left - 0.5
      }
    })
  for (const [width, zoom, theme, side] of [[620, 1.25, 'dark', null], [820, 1, 'dark', 'right'], [820, 1, 'light', 'left']]) {
    await inv('settings:update', { appearance: { theme } })
    await setAssistant(side)
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await lib.fitWindow(app, page, { width, height: 900 })
    const label = `project Overview, ${width} px at ${zoom * 100}%${side ? `, the Assistant on the ${side}` : ''} (${theme})`
    const f = await until(async () => {
      const x = await projectFits()
      // Too narrow for the table (under 300 px of page here), so it scrolls: in its own box, to its end.
      return x.page && x.own && x.whole && x.scrolls && x.reached && x.buttons ? x : null
    }, HUNG_MS)
    check(`${label}: the page doesn't scroll sideways; the session details keep their labels whole and scroll in their own box, to the end; the period buttons fit`, !!f, JSON.stringify(await projectFits()))
    await page.evaluate(() => document.querySelector('.session-meta').scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: path.join(lib.WORK, `wsoverview-project-${width}-${zoom * 100}${side ? `-${side}` : ''}-${theme}.png`) })
  }
  await setAssistant(null)
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
