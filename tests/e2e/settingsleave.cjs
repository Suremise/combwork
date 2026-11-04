// Leaving Settings (HI-2525): every activity bar item, a click in the side panel and a view's shortcut take you from
// Settings to that view; the gear brings Settings back at the section it was on, and nothing typed is lost.
// Throwaway profile and workspace; no sessions started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'settingsleave-profile')
const ws = path.join(scratch, 'settingsleave-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
for (const n of ['alpha', 'beta']) fs.mkdirSync(path.join(ws, n), { recursive: true })
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
const becomes = async (fn) => !!(await lib.until(fn, HUNG_MS))
;(async () => {
  lib.enableProviders(userData)
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ HIVE_USER_DATA: userData }) })
  try {
    const page = await app.firstWindow()
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.until(async () => (await page.locator('.project-row').count()) === 2, HUNG_MS)

    const settingsShown = () => page.locator('.main-area .settings-nav').count().then((n) => n === 1)
    const active = () => page.locator('.activity-btn.active').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).join(','))
    const section = () => page.locator('.settings-nav .row.selected').getAttribute('data-section').catch(() => null)
    const gear = async () => {
      await page.locator('.activity-btn[aria-label="Settings"]').click()
      return becomes(settingsShown)
    }
    const left = async (label) => becomes(async () => !(await settingsShown()) && (await active()) === label)

    // Settings on Agent API, as in Darren's screenshot.
    check('the gear opens Settings', await gear())
    await page.locator('.settings-nav .row[data-section="agentApi"]').click()
    check('…on Agent API', await becomes(async () => (await section()) === 'agentApi'))

    // Every item of the activity bar leaves Settings for its own view, and the gear brings Settings back at Agent API.
    const items = await page.locator('.activitybar .activity-btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    const views = items.filter((l) => !['Settings', 'Notifications'].includes(l))
    check('the activity bar lists its views', views.length >= 11 && views.includes('Dialects') && views.includes('Documentation'), views.join(', '))
    const stayed = []
    for (const label of views) {
      await page.locator(`.activitybar .activity-btn[aria-label="${label}"]`).click()
      if (!(await left(label))) stayed.push(`${label}: ${await active()}`)
      if (!(await gear()) || !(await becomes(async () => (await section()) === 'agentApi'))) stayed.push(`${label}: the gear didn't bring back Agent API (${await section()})`)
    }
    check('each activity bar item leaves Settings, and the gear returns to Agent API', stayed.length === 0, stayed.join('; '))

    // Dialects, a file chosen in its side panel, then Settings: the side panel still shows Dialects (the last view).
    await page.locator('.activitybar .activity-btn[aria-label="Dialects"]').click()
    await lib.until(async () => (await page.locator('.sidebar .dialect-row').count()) > 1, HUNG_MS)
    await gear()
    check('Settings keeps the last side panel beside it', await becomes(async () => (await page.locator('.sidebar .dialect-row').count()) > 1 && (await active()) === 'Settings'))
    await page.screenshot({ path: path.join(scratch, 'settingsleave-before.png') })
    // A click on a row of the side panel: Settings steps aside, and the row's own click still does its work.
    const row = page.locator('.sidebar .dialect-row').nth(1)
    const rowPath = await row.getAttribute('data-dialect')
    await row.click()
    check('a click in the side panel leaves Settings for its view', await left('Dialects'), await active())
    check('…and the row it clicked is chosen', await becomes(() => page.locator(`.sidebar .dialect-row.selected[data-dialect="${rowPath.replace(/\\/g, '\\\\')}"]`).count().then((n) => n === 1)))
    await page.screenshot({ path: path.join(scratch, 'settingsleave-after.png') })

    // The side panel's view already the last one: its activity bar button, with Settings open, also returns to it.
    await gear()
    await page.locator('.activitybar .activity-btn[aria-label="Dialects"]').click()
    check('the last side view\'s own button leaves Settings, sidebar kept', await left('Dialects') && (await page.locator('.sidebar').count()) === 1)

    // Dragging the side panel's edge isn't a click in it: Settings stays.
    await gear()
    const edge = await page.locator('.sidebar-resizer').boundingBox()
    await page.mouse.click(edge.x + edge.width / 2, edge.y + 200)
    check("a click on the side panel's edge keeps Settings", (await settingsShown()) && (await active()) === 'Settings')

    // A view's shortcut (its command, which the View menu's items run too) leaves Settings.
    await page.keyboard.press('Control+Shift+J')
    check('Ctrl+Shift+J (Task Board) leaves Settings', await left('Task Board'), await active())
    await gear()
    await page.keyboard.press('Control+Shift+E')
    check('Ctrl+Shift+E (Projects) leaves Settings', await left('Projects'), await active())

    // Nothing typed is lost: a box that saves as it loses the keyboard is saved, and one that saves only on its button
    // keeps its text until Settings is back.
    await gear()
    await page.locator('.settings-nav .row[data-section="general"]').click()
    const nameBox = page.locator('[data-setting$="userName"] input')
    await nameBox.click()
    await nameBox.fill('Half typed')
    await page.locator('.activitybar .activity-btn[aria-label="Task Board"]').click()
    check('leaving Settings saves a half-typed setting', await becomes(async () => (await inv('settings:get')).general.userName === 'Half typed'), JSON.stringify((await inv('settings:get')).general.userName))
    await gear()
    check('…shown again in Settings → General', await becomes(async () => (await section()) === 'general' && (await nameBox.inputValue()) === 'Half typed'))
    // The Projects list beside Settings this time.
    await page.locator('.activitybar .activity-btn[aria-label="Projects"]').click()
    await gear()
    await page.locator('.settings-nav .row[data-section="agentApi"]').click()
    const tokenName = page.getByLabel("New viewer token's name")
    await tokenName.fill('Apia')
    await page.locator('.sidebar .project-row').first().click()
    check('a click in the side panel leaves Settings with a half-typed name', await left('Projects'), await active())
    await gear()
    check('…and the name is still there when Settings is back', await becomes(async () => (await section()) === 'agentApi' && (await tokenName.inputValue()) === 'Apia'))
    await page.screenshot({ path: path.join(scratch, 'settingsleave-draft.png') })
  } catch (e) {
    fail++
    console.log('FAIL', e.stack || e)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
