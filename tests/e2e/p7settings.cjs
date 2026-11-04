// P7's switches set in the window (#1563, tests/workflow/README.md's P7 table): Settings → Advanced's rows for the slots'
// and copies' switches (Remove idle slots after a day, Delete a card's branch once it's merged, Rename adopted worktrees
// to slot names, Copies: wait for one to be free, Remove Hive's skill copies when no agent works in the folder) each
// changed there, written to advanced.json and read by the main process; and the workflow option Wake reviewers and
// builders (loopWakes, under Card loops in Version Control → Workflow since HI-1766) turned off and on with Save, in
// project.json's options. What each does is other suites' (slotswitches,
// slotscripts, copyquiet, skilldelivery, loopwakes). Dev build, throwaway profile and workspace; no agent runs.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const at = (x) => path.join(lib.WORK, `p7settings-${x}`)
const userData = at('profile')
const ws = at('ws')
const alpha = path.join(ws, 'alpha')
const file = path.join(userData, 'advanced.json')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const values = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).values ?? {} : {})

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(alpha, { recursive: true })
  const h = await lib.launch({ userData })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    // What the main process holds (advanced.get's overrides), as advanced:state reports it.
    const inMain = async (id) => (await inv('advanced:state')).values[id]

    // --- Settings → Advanced: each switch's row, its own value changed there.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    const list = page.locator('.advanced-list')
    check('Settings → Advanced shows the list', !!(await until(async () => (await list.count()) === 1, HUNG_MS)))
    const row = (id) => list.locator(`.advanced-row[data-advanced="${id}"]`)
    for (const id of ['cw.slots.removeIdle', 'cw.slots.deleteMergedLines', 'cw.slots.renameAdopted']) {
      const sw = row(id).getByRole('switch').first()
      await sw.scrollIntoViewIfNeeded()
      check(`${id}: on by default`, (await sw.getAttribute('aria-checked')) === 'true' && !(id in values()))
      await sw.click()
      check(`…turned off in the window: in advanced.json`, !!(await until(() => values()[id] === false, HUNG_MS)), JSON.stringify(values()))
      check('…read by the main process, shown modified', !!(await until(async () => (await inMain(id)) === false && (await row(id).locator('.modified').count()) === 1, HUNG_MS)), JSON.stringify(await inMain(id)))
    }
    await page.screenshot({ path: at('1-switches.png') })

    // Copies: wait for one to be free, in minutes.
    const quiet = row('cw.copies.quietWaitMinutes')
    const box = quiet.getByLabel('Combwork: Copies: wait for one to be free', { exact: true })
    await box.scrollIntoViewIfNeeded()
    check('cw.copies.quietWaitMinutes: 10 by default', (await box.inputValue()) === '10')
    await box.fill('3')
    await box.press('Enter')
    check('…set to 3 in the window: in advanced.json', !!(await until(() => values()['cw.copies.quietWaitMinutes'] === 3, HUNG_MS)), JSON.stringify(values()))
    check('…read by the main process', !!(await until(async () => (await inMain('cw.copies.quietWaitMinutes')) === 3, HUNG_MS)))

    // Remove Hive's skill copies when no agent works in the folder: Slots only, Everywhere, Never.
    const copies = row('cw.skills.removeIdleCopies').locator('select').first()
    await copies.scrollIntoViewIfNeeded()
    check('cw.skills.removeIdleCopies: Slots only by default', (await copies.inputValue()) === 'slots')
    for (const v of ['never', 'everywhere']) {
      await copies.selectOption(v)
      check(`…set to ${v} in the window: in advanced.json, read by the main process`, !!(await until(async () => values()['cw.skills.removeIdleCopies'] === v && (await inMain('cw.skills.removeIdleCopies')) === v, HUNG_MS)), JSON.stringify(values()))
    }
    await page.screenshot({ path: at('2-copies.png') })

    // --- Version Control → Workflow → Card loops: Wake reviewers and builders (HI-1766), saved with Save….
    await page.keyboard.press('Escape')
    const own = async () => (await inv('workflow:form', alpha)).own.loopWakes
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click().catch(() => {})
    const wakeRow = page.locator('.workflow-form .workflow-group[data-group="loops"] .workflow-option[data-option="loopWakes"]')
    const wake = wakeRow.getByRole('switch')
    check('Card loops: Wake reviewers and builders, on, from the default', !!(await until(async () => (await wake.count()) === 1 && (await wake.getAttribute('aria-checked')) === 'true', HUNG_MS)) && (await own()) === undefined && (await wakeRow.locator('.workflow-origin').innerText()).includes('Default'), await wakeRow.innerText().catch(() => ''))
    const save = async () => {
      await page.locator('.workflow-form [data-action="save"]').click()
      const dialog = page.locator('.dialog', { hasText: 'Save Workflow Options' })
      await dialog.waitFor({ timeout: HUNG_MS })
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    }
    await wake.click()
    await save()
    check('…turned off and saved: loopWakes false in the project’s options, set for this project', !!(await until(async () => (await own()) === false && (await wake.getAttribute('aria-checked')) === 'false' && (await wakeRow.locator('.workflow-origin').innerText()).includes('Set for this project'), HUNG_MS)), JSON.stringify(await own()))
    await page.screenshot({ path: at('3-loops.png') })
    await wake.click()
    await save()
    check('…and on again', !!(await until(async () => (await own()) === true, HUNG_MS)))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
