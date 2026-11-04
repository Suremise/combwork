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
      check(`${what}: a click on it opens its section`, await lib.until(async () => (await nav.evaluate((n) => n.querySelector('.row.selected')?.dataset.section ?? null)) === id, HUNG_MS), id)
      await checkKeyboard(what, nav, all, i)
    }

    /** The keyboard in a section list (HI-2532): reached by Tab, arrows, Home and End choose, Enter and Space too. */
    const checkKeyboard = async (what, nav, all, cutAt) => {
      const rows = nav.locator('.row')
      const ids = await rows.evaluateAll((els) => els.map((r) => r.dataset.section))
      // Read at once: a locator's getAttribute waits for a row selected, and none is while a search shows them all.
      const selected = () => nav.evaluate((n) => n.querySelector('.row.selected')?.dataset.section ?? null)
      const focused = () => page.evaluate(() => { const a = document.activeElement; return a?.matches('.settings-nav .row:focus-visible') ? a.dataset.section : null })
      const at = (id) => lib.until(async () => (await selected()) === id && (await focused()) === id, HUNG_MS)
      const search = page.locator('.tab-body .settings-top input[type="search"], .tab-body .settings-top input.input').first()
      check(`${what}: the list is a vertical tab list, its rows tabs`, (await nav.getAttribute('role')) === 'tablist' && (await nav.getAttribute('aria-orientation')) === 'vertical' && !!(await nav.getAttribute('aria-label')) && (await rows.evaluateAll((els) => els.every((r) => r.getAttribute('role') === 'tab'))))
      check(`${what}: one row in the Tab order, the selected one`, JSON.stringify(await rows.evaluateAll((els) => els.filter((r) => r.tabIndex === 0).map((r) => r.dataset.section))) === JSON.stringify([await selected()]))
      // Tab from the search box (past Modified only, in Settings) reaches the selected section.
      const sel = await selected()
      await search.click()
      for (let n = 0; n < 3 && (await focused()) !== sel; n++) await page.keyboard.press('Tab')
      check(`${what}: Tab from the search reaches the selected section`, (await focused()) === sel, `${await focused()} (${sel})`)
      await page.keyboard.press('Home')
      check(`${what}: Home chooses the first section`, !!(await at(ids[0])), await selected())
      await page.keyboard.press('ArrowDown')
      check(`${what}: Down chooses the next, the focus with it`, !!(await at(ids[1])), await selected())
      await page.keyboard.press('ArrowUp')
      check(`${what}: Up the one before`, !!(await at(ids[0])), await selected())
      await page.keyboard.press('ArrowUp')
      check(`${what}: Up on the first wraps to the last`, !!(await at(ids[ids.length - 1])), await selected())
      await page.keyboard.press('Home')
      await page.keyboard.press('End')
      check(`${what}: End chooses the last`, !!(await at(ids[ids.length - 1])), await selected())
      // A cut name, focused by the keyboard, shows in full (HI-2531's tooltip).
      await page.keyboard.press('Home')
      for (let n = 0; n < cutAt; n++) await page.keyboard.press('ArrowDown')
      const tip = await lib.until(async () => { const t = await page.locator('.tip:visible').last().innerText({ timeout: 1000 }).catch(() => ''); return t === all[cutAt].text && t }, HUNG_MS)
      check(`${what}: a cut name shows in full when the keyboard focuses it`, tip === all[cutAt].text, `${tip} (${all[cutAt].text})`)
      // While a search shows every section, none is chosen: the first row is in the Tab order, and Enter or Space chooses.
      await search.fill('a')
      await lib.until(async () => (await selected()) === null, HUNG_MS)
      check(`${what}: while searching, the first row is the one in the Tab order`, JSON.stringify(await rows.evaluateAll((els) => els.filter((r) => r.tabIndex === 0).map((r) => r.dataset.section))) === JSON.stringify([ids[0]]))
      await rows.first().focus()
      await page.keyboard.press('Enter')
      check(`${what}: Enter chooses the focused section, ending the search`, !!(await lib.until(async () => (await selected()) === ids[0] && (await search.inputValue()) === '', HUNG_MS)), await selected())
      await search.fill('a')
      await lib.until(async () => (await selected()) === null, HUNG_MS)
      await rows.nth(2).focus()
      await page.keyboard.press(' ')
      check(`${what}: Space chooses it too`, !!(await lib.until(async () => (await selected()) === ids[2] && (await search.inputValue()) === '', HUNG_MS)), await selected())
      await page.screenshot({ path: path.join(scratch, `settingsnav-${what.toLowerCase().replace(/\s+/g, '-')}-keyboard.png`) })
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
