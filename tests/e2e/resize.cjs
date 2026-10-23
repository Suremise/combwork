// Resizable panes: drag the list dividers and the Markdown split, check sizes persist and reset.
// Throwaway profile and workspace; no sessions started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'resize-profile')
const ws = path.join(scratch, 'resize-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
fs.writeFileSync(path.join(ws, 'demo', 'README.md'), '# Demo\n\nSome text.\n')
require('child_process').execSync('git init -q', { cwd: path.join(ws, 'demo'), env: lib.gitEnv() })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const HUNG_MS = 15000
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
;(async () => {
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws); await sleep(800)
  // "How do you work?" answered (#1423), as a user does once: its step, shown once the form is read, moves what is dragged.
  await inv('workflow:presetNotNow', path.join(ws, 'demo'), 'git')
  // …and the window has the answer (the refresh it makes), before anything is measured.
  await lib.until(async () => (await page.evaluate(() => window.hive.invoke('workspace:refresh')))?.projects.find((p) => p.name === 'demo')?.config.workflow?.presetAsked === 'notNow', 10000)
  await page.getByText('demo', { exact: true }).first().click(); await sleep(400)

  const drag = async (handle, dx) => {
    const b = await handle.boundingBox()
    const x = b.x + b.width / 2, y = b.y + b.height / 2
    await page.mouse.move(x, y); await page.mouse.down()
    await page.mouse.move(x + dx / 2, y, { steps: 4 }); await page.mouse.move(x + dx, y, { steps: 4 })
    await page.mouse.up(); await sleep(300)
  }
  const width = (sel) => page.locator(sel).first().evaluate((e) => Math.round(e.getBoundingClientRect().width))

  for (const [tab, key, def] of [['Sessions', 'sessions', 320], ['Files', 'files', 360], ['Version Control', 'changes', 280], ['Memory', 'memory', 280]]) {
    if (tab === 'Memory') await lib.openMoreTab(page, tab)
    else await page.locator('.tabs .tab', { hasText: tab }).first().click()
    const list = '.tab-body:visible .split-list'
    await lib.until(async () => (await page.locator('.tabs .tab.active .tab-label').innerText().catch(() => '')).trim() === tab && (await page.locator(list).count()) > 0, 10000)
    // Version Control's header finishes once its workflow form is read (its link): measured after, not while it lays out.
    if (tab === 'Version Control') await lib.until(async () => (await page.locator('[data-action="vc-workflow"]').count()) === 1, 10000)
    const w0 = await width(list)
    check(`${tab} default width`, Math.abs(w0 - def) <= 1, `(${w0})`)
    await drag(page.locator(`${list} > .pane-resizer`).first(), 120)
    const w1 = await width(list)
    check(`${tab} drag widens`, Math.abs(w1 - (def + 120)) <= 3, `(${w1})`)
    const saved = (await inv('ui:get')).panes?.[key]
    check(`${tab} saved`, Math.abs(saved - w1) <= 1, `(${saved})`)
    await drag(page.locator(`${list} > .pane-resizer`).first(), -900)
    check(`${tab} min 200`, (await width(list)) === 200)
    await page.locator(`${list} > .pane-resizer`).first().dblclick(); await sleep(300)
    check(`${tab} dblclick resets`, Math.abs((await width(list)) - def) <= 1 && (await inv('ui:get')).panes?.[key] === undefined)
    if (tab === 'Files') {
      await drag(page.locator(`${list} > .pane-resizer`).first(), 5000)
      const main = await width('.tab-body:visible .split-main')
      check('Files max keeps main >= 320', main >= 318, `(main ${main})`)
      await page.locator(`${list} > .pane-resizer`).first().dblclick(); await sleep(300)
      // Markdown split view
      await page.getByText('README.md', { exact: true }).first().click(); await lib.until(async () => (await page.locator('.tab-body:visible .segmented button', { hasText: 'Split' }).count()) > 0, 10000)
      await page.locator('.segmented button', { hasText: 'Split' }).first().click(); await lib.until(async () => (await page.locator('.tab-body:visible .split-half').count()) === 2, 10000)
      const halves = page.locator('.tab-body:visible .split-half')
      const host = await width('.tab-body:visible .editor-host')
      const h0 = await halves.first().evaluate((e) => e.getBoundingClientRect().width)
      check('split default 50%', Math.abs(h0 / host - 0.5) < 0.02, `(${(h0 / host).toFixed(3)})`)
      await drag(halves.first().locator('.pane-resizer'), -150)
      const h1 = await halves.first().evaluate((e) => e.getBoundingClientRect().width)
      const r = (await inv('ui:get')).panes?.fileSplit
      check('split drag narrows editor', Math.abs(h1 - (h0 - 150)) <= 4, `(${Math.round(h1)} vs ${Math.round(h0 - 150)})`)
      check('split ratio saved', Math.abs(r - h1 / host) < 0.01, `(${r})`)
      await page.screenshot({ path: path.join(scratch, 'resize-split.png') })
      await drag(halves.first().locator('.pane-resizer'), -3000)
      const h2 = await halves.first().evaluate((e) => e.getBoundingClientRect().width)
      check('split min 20%', Math.abs(h2 / host - 0.2) < 0.01, `(${(h2 / host).toFixed(3)})`)
      await halves.first().locator('.pane-resizer').dblclick(); await sleep(300)
      const h3 = await halves.first().evaluate((e) => e.getBoundingClientRect().width)
      check('split dblclick resets', Math.abs(h3 / host - 0.5) < 0.02)
    }
  }
  // Persistence across a reload (#717: under load it failed once, with nothing to say why). Each step waits for what the
  // next needs: the Git tab's divider drawn before the drag, the width saved before the reload, the list at its width after.
  const gitList = '.tab-body:visible .split-list'
  await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
  await lib.until(async () => (await page.locator(`${gitList} > .pane-resizer`).count()) > 0, HUNG_MS)
  await drag(page.locator(`${gitList} > .pane-resizer`).first(), 60)
  const savedGit = await lib.until(async () => (await inv('ui:get')).panes?.changes ?? null, HUNG_MS)
  check('Git width saved before the reload', Math.abs(savedGit - 340) <= 3, `(${savedGit})`)
  await page.reload(); await lib.appReady(page)
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
  const gitWidth = async () => ((await page.locator(gitList).count()) > 0 ? width(gitList) : null)
  const kept = await lib.until(async () => { const w = await gitWidth(); return w !== null && Math.abs(w - 340) <= 3 ? w : null }, HUNG_MS)
  check('width kept after reload', !!kept, `(${kept ?? await gitWidth()})`)
  await page.screenshot({ path: path.join(scratch, 'resize-changes.png') })
  // Docs view
  await page.evaluate(() => { const b = [...document.querySelectorAll('.activity-btn')].find((e) => /Documentation/.test(e.getAttribute('aria-label') || '')); b?.click() }); await sleep(800)
  const d0 = await width('.split-list:visible')
  await drag(page.locator('.split-list:visible > .pane-resizer').first(), 80)
  check('Docs list resizes', Math.abs((await width('.split-list:visible')) - (d0 + 80)) <= 3, `(${d0} → ${await width('.split-list:visible')})`); await page.screenshot({ path: path.join(scratch, 'resize-docs.png') })
  console.log(`${pass}/${pass + fail} passed`)
  await app.close()
  // No delete of its folders here (#324): the runner gives the suite a new folder and removes it when it passes; a run
  // on its own empties them when it starts. Right after app.close() the CLI it stopped can still hold one, and a
  // failed delete here failed a suite whose checks had all passed.
})().catch((e) => { console.error(e); process.exit(1) })
