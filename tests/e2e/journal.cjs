// The Assistant's journal in Settings (#1031): Settings → Assistant → Journal shows it on, work only by default, with no
// journal yet; Hive's facts fill it (a card into Done) and its size shows; a kind ticked, its two numbers (a blank or
// out-of-range box saving nothing, HI-2345), the journal turned off (the
// entries kept) and on again are saved in the workspace's workspace.json; Delete Journal… asks, then the file goes to the
// trash, and the copy starts with tips off. Both themes. No agents (its tools are measured in replysize). Dev build, or
// a packaged one with HIVE_EXE (#1599: its deletion goes to the suite's trash folder too). Throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'journal-profile')
const ws = path.join(lib.WORK, 'journal-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const saved = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'workspace.json'), 'utf8')).journal ?? null
  } catch {
    return null
  }
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    // A test copy starts with tips off (HIVE_TEST_TIPS=off), packaged with HIVE_EXE too (#1599).
    check('tips are off in a test copy, and no tip card shows', (await inv('settings:get')).general.showTips === false && (await page.locator('.tip-card').count()) === 0)
    const openSection = async () => {
      await page.keyboard.press('Control+,')
      await page.locator('.settings-nav .row', { hasText: 'General' }).click()
      await page.locator('.settings-nav .row', { hasText: 'Assistant' }).click()
    }
    await openSection()
    const panel = page.locator('.journal-settings')
    check('Settings → Assistant shows the Journal', !!(await lib.until(async () => (await panel.count()) === 1, HUNG_MS)))
    const box = (kind) => panel.locator(`input[data-kind="${kind}"]`)
    const ticked = async () => {
      const out = []
      for (const k of ['decision', 'plan', 'event', 'incident', 'insight', 'preference', 'moment']) if (await box(k).isChecked()) out.push(k)
      return out
    }
    check('on, work only by default', (await panel.getByRole('switch').getAttribute('aria-checked')) === 'true' && JSON.stringify(await ticked()) === JSON.stringify(['decision', 'plan', 'event', 'incident', 'insight']))
    check('no journal yet, kept on this computer only', /No journal yet\. Kept on this computer only/.test(await panel.innerText()), await panel.innerText())
    check('nothing to delete yet', await panel.getByRole('button', { name: 'Delete Journal…' }).isDisabled())

    // A card into Done: a fact by Hive, and the size shows.
    const card = await inv('tasks:create', { title: 'Shipped it', project: 'alpha' })
    await inv('tasks:update', card.number, { column: 'done' })
    await openSection()
    check('Combwork recorded the merge: its size and one entry show', !!(await lib.until(async () => /Now [\d.,]+ [KM]?B, 1 entry\./.test(await panel.innerText()), HUNG_MS)), await panel.innerText())
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await panel.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(lib.WORK, `journal-settings-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    // A kind ticked, saved in workspace.json.
    await box('preference').click()
    check('ticking Your preferences saves it for the workspace', !!(await lib.until(() => saved()?.scope?.includes('preference'), HUNG_MS)), JSON.stringify(saved()))
    // The numbers (HI-2345): a blank box keeps the saved number, one out of range says so and saves nothing, a valid one
    // is saved. Cleared, the box used to save 0, which main raised to the minimum (7 days, 5 MB) and pruned to at once.
    const days = panel.getByLabel('Keep everyday entries for', { exact: true })
    const cap = panel.getByLabel('Size cap', { exact: true })
    const fieldError = (input) => input.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " number-field ")][1]').locator('.field-error')
    await days.fill('')
    await days.press('Enter')
    check('a cleared retention box keeps 90 days, saving nothing', !!(await lib.until(async () => (await days.inputValue()) === '90', HUNG_MS)) && saved()?.retentionDays === 90, JSON.stringify(saved()))
    await days.fill('3')
    await days.press('Enter')
    check('…3 days, out of range, says so', !!(await lib.until(async () => (await fieldError(days).count()) === 1, HUNG_MS)), await panel.innerText())
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(lib.WORK, 'journal-settings-out-of-range.png') })
    check('…and saves nothing, the box back at 90', saved()?.retentionDays === 90 && (await days.inputValue()) === '90', JSON.stringify(saved()))
    await cap.fill('')
    await cap.press('Enter')
    check('a cleared size cap keeps 50 MB, saving nothing', !!(await lib.until(async () => (await cap.inputValue()) === '50', HUNG_MS)) && saved()?.capMB === 50, JSON.stringify(saved()))
    await cap.fill('2')
    await cap.press('Enter')
    check('…2 MB says so and saves nothing', !!(await lib.until(async () => (await fieldError(cap).count()) === 1, HUNG_MS)) && saved()?.capMB === 50, JSON.stringify(saved()))
    await days.fill('30')
    await days.press('Enter')
    check('a retention in range is saved', !!(await lib.until(() => saved()?.retentionDays === 30, HUNG_MS)), JSON.stringify(saved()))
    await cap.fill('20')
    await cap.press('Enter')
    check('…and a size cap in range', !!(await lib.until(() => saved()?.capMB === 20, HUNG_MS)), JSON.stringify(saved()))
    // No limit, then a cap again.
    await panel.locator('.journal-nolimit').click()
    check('No limit saves no cap', !!(await lib.until(() => saved()?.capMB === null, HUNG_MS)), JSON.stringify(saved()))
    await panel.locator('.journal-nolimit').click()
    check('…and a cap of 50 MB again', !!(await lib.until(() => saved()?.capMB === 50, HUNG_MS)), JSON.stringify(saved()))

    // Off keeps the entries; nothing more is written.
    await panel.getByRole('switch').click()
    check('off is saved, and says the entries are kept', !!(await lib.until(async () => saved()?.enabled === false && /the entries are kept/.test(await panel.innerText()), HUNG_MS)))
    const other = await inv('tasks:create', { title: 'While off', project: 'alpha' })
    await inv('tasks:update', other.number, { column: 'done' })
    check('while off, Hive writes nothing; the entry is kept', (await inv('journal:status')).entries === 1)
    await panel.getByRole('switch').click()
    check('on again', !!(await lib.until(() => saved()?.enabled === true, HUNG_MS)))

    // Delete Journal… asks, then the file goes to the trash.
    await panel.getByRole('button', { name: 'Delete Journal…' }).click()
    const ask = page.locator('.dialog', { hasText: "Delete the Assistant's journal?" })
    check('Delete asks first, saying how many entries go', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)) && /All 1 entry of this workspace go to the Recycle Bin/.test(await ask.innerText()), await ask.innerText().catch(() => ''))
    await page.screenshot({ path: path.join(lib.WORK, 'journal-delete.png') })
    await ask.getByRole('button', { name: 'Delete', exact: true }).click()
    check('…then it is gone: no journal yet', !!(await lib.until(async () => /No journal yet/.test(await panel.innerText()), HUNG_MS)))
    check('…its file in the trash', !!(await lib.until(() => lib.trashed(path.join('journal-ws', '.combwork', 'assistant', 'journal.db')).length >= 1, HUNG_MS)))
    check('the settings stay as they were', saved()?.enabled === true && saved()?.scope?.includes('preference'))
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
