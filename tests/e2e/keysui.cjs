// Project keys in the window (#1221): New Project… suggests a key from the name as it is typed and checks the one typed
// (its form, another project's key, one beginning another's), each with its reason, and creates the project with it;
// Project Settings changes it, saying the old one stays, and lists the old key after; the board's search and the command
// palette find cards by key (any case), by a project's key alone (AM-) and by the old key; Depends on takes a key. Both
// themes' screenshots of the dialog and the settings row. Dev build, throwaway profile and workspace; no CLI is started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'keysui-profile')
const ws = path.join(lib.WORK, 'keysui-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(path.join(ws, 'hive'))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const keyOf = async (name) => (await inv('project:keys')).find((k) => path.basename(k.projectPath) === name) ?? null
    check('the workspace’s project has its key (hive: HI)', !!(await lib.until(async () => (await keyOf('hive'))?.key === 'HI', HUNG_MS)), JSON.stringify(await inv('project:keys')))
    const themes = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await (target ?? page).screenshot({ path: path.join(lib.WORK, `keysui-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const palette = async (text) => {
      await page.keyboard.press('Control+Shift+P')
      const box = page.locator('.palette input')
      await box.waitFor({ timeout: HUNG_MS })
      await box.fill(text)
      return box
    }

    // --- New Project…: the key follows the name until it is typed, and is checked as it changes.
    await palette('New Project')
    await page.locator('.palette-item', { hasText: 'New Project' }).first().click()
    const dialog = page.locator('.dialog', { hasText: 'New Project' })
    await dialog.waitFor({ timeout: HUNG_MS })
    const name = dialog.locator('input').first()
    const key = dialog.getByRole('textbox', { name: 'Key', exact: true })
    const error = dialog.locator('.field-error')
    const hint = dialog.locator('.field-hint')
    await name.fill('web-app')
    check('the key follows the name typed: a suggestion', (await key.inputValue()) === 'WE', await key.inputValue())
    check('…saying how its cards will be named', /WE-1, WE-2/.test(await hint.innerText().catch(() => '')), await hint.innerText().catch(() => ''))
    for (const [typed, why, what] of [
      ['hi', /HI is another project’s key/, "another project's key"],
      ['HIV', /HIV and HI, another project’s key, begin alike/, 'one beginning another'],
      ['H', /2 to 4 letters/, 'too short']
    ]) {
      await key.fill(typed)
      check(`a key typed is checked as it changes: ${what}, with its reason`, !!(await lib.until(async () => why.test(await error.innerText().catch(() => '')), HUNG_MS)) && (await key.getAttribute('aria-invalid')) === 'true', await error.innerText().catch(() => ''))
    }
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    check('…and a key that can’t be one keeps the dialog open', (await dialog.count()) === 1 && !fs.existsSync(path.join(ws, 'web-app')))
    await themes('newproject-error', dialog)
    await key.fill('wb')
    check('a key typed is shown in capitals; one that can be shows how its cards are named', (await key.inputValue()) === 'WB' && (await error.count()) === 0 && /WB-1, WB-2/.test(await hint.innerText()), await key.inputValue())
    await name.fill('web-app-2')
    check('…and the name no longer changes it once typed', (await key.inputValue()) === 'WB', await key.inputValue())
    await name.fill('web-app')
    await themes('newproject', dialog)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    check('Create makes the project with the key chosen', !!(await lib.until(async () => (await keyOf('web-app'))?.key === 'WB', HUNG_MS)), JSON.stringify(await keyOf('web-app')))

    // --- Cards by key on the board.
    const c1 = await inv('tasks:create', { title: 'Login form', project: 'web-app' })
    const c2 = await inv('tasks:create', { title: 'Sign-up form', project: 'web-app' })
    const h1 = await inv('tasks:create', { title: 'Hive card', project: 'hive' })
    check('cards are named by their project’s key', c1.key === 'WB-1' && c2.key === 'WB-2' && h1.key === 'HI-1', JSON.stringify([c1.key, c2.key, h1.key]))
    await page.getByRole('button', { name: 'Task Board' }).click()
    const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
    check('a tile shows its card’s key', !!(await lib.until(async () => ((await tile(c1.number).locator('.task-number').innerText().catch(() => '')) === 'WB-1'), HUNG_MS)), await tile(c1.number).locator('.task-number').innerText().catch(() => ''))
    const search = page.getByPlaceholder('Search cards (AM-12, words, labels)')
    const shown = async () => (await page.locator('.task-card').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-task'))))).sort((a, b) => a - b)
    const finds = async (q, want) => {
      await search.fill(q)
      return !!(await lib.until(async () => JSON.stringify(await shown()) === JSON.stringify(want), HUNG_MS))
    }
    check('the board’s search finds a card by key', await finds('WB-2', [c2.number]), JSON.stringify(await shown()))
    check('…in any case', await finds('wb-1', [c1.number]), JSON.stringify(await shown()))
    check('…every card of a project by its key alone (WB-)', await finds('WB-', [c1.number, c2.number]), JSON.stringify(await shown()))
    check('…and by number, as before', await finds(`#${h1.number}`, [h1.number]), JSON.stringify(await shown()))
    await search.fill('')

    // --- Project Settings: change the key; the old one is listed and still finds the cards.
    await page.getByRole('button', { name: 'Projects' }).click()
    await page.locator('.project-row', { hasText: 'web-app' }).first().click()
    await lib.openProjectSettings(page)
    const field = page.getByRole('textbox', { name: 'Project key', exact: true })
    await field.waitFor({ timeout: HUNG_MS })
    check('Project Settings shows the key', (await field.inputValue()) === 'WB', await field.inputValue())
    await field.fill('hi')
    check('a key taken is refused as it is typed, saying why', /HI is another project’s key/.test(await page.locator('.project-key-field .field-error').innerText().catch(() => '')) && (await page.locator('.project-key-field').getByRole('button', { name: 'Change' }).isDisabled()))
    await field.fill('WBA')
    check('a new key says the old one keeps finding its cards', /WBA-12; WB-12 will still find them/.test(await page.locator('.project-key-field .field-hint').innerText().catch(() => '')), await page.locator('.project-key-field').innerText())
    await themes('settings-change', page.locator('.project-key-field').locator('xpath=ancestor::*[contains(@class,"setting")][1]'))
    await page.locator('.project-key-field').getByRole('button', { name: 'Change' }).click()
    check('Change makes it the project’s key, the old one an alias', !!(await lib.until(async () => { const k = await keyOf('web-app'); return k?.key === 'WBA' && k.aliases.includes('WB') }, HUNG_MS)), JSON.stringify(await keyOf('web-app')))
    check('…and the field lists the old key', !!(await lib.until(async () => /Its old keys, which still find its cards: WB/.test(await page.locator('.project-key-field .field-hint').innerText().catch(() => '')), HUNG_MS)), await page.locator('.project-key-field').innerText().catch(() => ''))
    await themes('settings', page.locator('.project-key-field').locator('xpath=ancestor::*[contains(@class,"setting")][1]'))

    // --- The palette: a card's name lists it first, and opens it; the old key finds it too.
    await palette('wba-1')
    const item = page.locator('.palette-item', { hasText: 'Open Card: WBA-1 Login form' })
    check('the palette lists a card by its key, first', !!(await lib.until(async () => (await item.count()) === 1 && (await page.locator('.palette-item').first().innerText()).includes('WBA-1 Login form'), HUNG_MS)), await page.locator('.palette-list').innerText().catch(() => ''))
    await themes('palette', page.locator('.palette'))
    await item.click()
    const cardDialog = page.locator('.dialog', { hasText: `WBA-1 (#${c1.number})` })
    check('…and choosing it opens the card, its title its key and number', !!(await lib.until(async () => (await cardDialog.count()) === 1, HUNG_MS)))
    // Depends on takes a key, the old one too.
    await cardDialog.getByPlaceholder('Cards to finish first, e.g. AM-3 AM-5').fill('WB-2')
    await cardDialog.getByRole('button', { name: 'Save', exact: true }).click()
    check('Depends on takes a card’s key, an old one too', !!(await lib.until(async () => JSON.stringify((await inv('tasks:list')).find((c) => c.number === c1.number)?.blockedBy) === JSON.stringify([c2.number]), HUNG_MS)), JSON.stringify((await inv('tasks:list')).find((c) => c.number === c1.number)?.blockedBy))
    await page.keyboard.press('Escape')
    await palette('WB-')
    check('the palette finds a project’s cards by its old key alone', !!(await lib.until(async () => (await page.locator('.palette-item', { hasText: 'Open Card: WBA-' }).count()) === 2, HUNG_MS)), await page.locator('.palette-list').innerText().catch(() => ''))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
