// Settings' and Project Settings' section lists (HI-2531): rows stay compact, a name cut with "…" in a narrow window
// shows in full in the app's tooltip on hover, and one that fits shows none.
// Throwaway profile and workspace; no sessions started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'settingsnav-profile')
const ws = path.join(scratch, 'settingsnav-ws')
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
    // 900 px with the side panel open, as the audit (HI-2529) found it: section names are cut.
    await lib.fitWindow(app, page, { width: 900, height: 860 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.until(async () => (await page.locator('.project-row').count()) === 1, HUNG_MS)
    await inv('project:setActive', path.join(ws, 'alpha'), true)

    /** Checks a section list: compact rows, a cut name's tooltip on hover, none for one that fits. */
    const checkList = async (what, nav) => {
      const rows = nav.locator('.row')
      await lib.until(async () => (await rows.count()) > 3, HUNG_MS)
      const all = await rows.evaluateAll((els) => els.map((r) => { const l = r.querySelector('.label'); return { text: l.textContent, cut: l.scrollWidth > l.clientWidth + 1, height: Math.round(r.getBoundingClientRect().height) } }))
      check(`${what}: rows stay compact`, all.every((r) => r.height === 30), JSON.stringify([...new Set(all.map((r) => r.height))]))
      const i = all.findIndex((r) => r.cut)
      if (i < 0) return check(`${what}: a section name is cut at 900 px`, false, JSON.stringify(all.map((r) => r.text)))
      const full = all[i].text
      const tip = await lib.hoverTip(page, rows.nth(i), (t) => t === full)
      check(`${what}: hovering a cut name shows it in full`, tip === full, JSON.stringify({ tip, full, cut: all.filter((r) => r.cut).map((r) => r.text) }))
      await page.screenshot({ path: path.join(scratch, `settingsnav-${what.toLowerCase().replace(/\s+/g, '-')}-tip.png`) })
      const j = all.findIndex((r) => !r.cut)
      if (j >= 0) {
        await page.mouse.move(5, 5)
        await rows.nth(j).hover()
        // A tip would show after its delay: wait until one does or the bound passes, then say none came.
        const came = await lib.until(async () => (await page.locator('.tip:visible').count()) > 0, 1500)
        check(`${what}: a name that fits shows no tooltip`, !came, all[j].text)
      }
      // A click on a row whose name is cut still opens its section.
      const id = await rows.nth(i).getAttribute('data-section')
      await rows.nth(i).click()
      check(`${what}: a click on it opens its section`, await lib.until(async () => (await nav.locator('.row.selected').getAttribute('data-section').catch(() => null)) === id, HUNG_MS), id)
    }

    await page.locator('.activitybar .activity-btn[aria-label="Settings"]').click()
    await checkList('Settings', page.locator('.main-area .settings-nav'))

    await page.locator('.activitybar .activity-btn[aria-label="Projects"]').click()
    await page.locator('.project-row').first().click()
    await lib.openProjectSettings(page)
    await checkList('Project Settings', page.locator('.tab-body .settings-nav'))
  } catch (e) {
    fail++
    console.log('FAIL', e.stack || e)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
