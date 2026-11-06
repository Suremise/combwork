// Project keys in the window (#1221): New Project… suggests a key from the name as it is typed and checks the one typed
// (its form, another project's key, one beginning another's), each with its reason, and creates the project with it; a
// key typed before the window has the projects' keys is checked once it has them (HI-2653: the reads held);
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
  lib.gitProject(path.join(ws, 'hilltop'))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    // The window's reads of the projects' keys are held until released (HI-2653): under a full set's load the New Project
    // dialog opened before the board's first read had them, and checked the key typed against none.
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      const h = handlers.get('project:keys')
      globalThis.__keysHold = { on: true, held: [] }
      handlers.set('project:keys', (...x) => (globalThis.__keysHold.on ? new Promise((r) => globalThis.__keysHold.held.push(() => r(h(...x)))) : h(...x)))
    })
    const heldKeyReads = () => app.evaluate(() => globalThis.__keysHold.held.length)
    const releaseKeys = () => app.evaluate(() => {
      globalThis.__keysHold.on = false
      for (const r of globalThis.__keysHold.held.splice(0)) r()
    })
    await lib.openWorkspace(inv, page, ws)
    const keyOf = async (name) => (await inv('project:keys')).find((k) => path.basename(k.projectPath) === name) ?? null
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
    // The dialog as it is: both boxes, the hint and the error, for a check's evidence.
    const boxes = async () => `[name: ${await name.inputValue().catch(() => '?')}, key: ${await key.inputValue().catch(() => '?')}, hint: ${await hint.innerText({ timeout: 500 }).catch(() => '')}, error: ${await error.innerText({ timeout: 500 }).catch(() => '')}]`
    const textOf = (loc) => loc.innerText({ timeout: 500 }).catch(() => '')
    await name.fill('web-app')
    check('the key follows the name typed: a suggestion, saying how its cards will be named', !!(await lib.until(async () => (await key.inputValue()) === 'WE' && /WE-1, WE-2/.test(await textOf(hint)), HUNG_MS)), await boxes())
    // A key typed while the window hasn't the keys yet is checked once it has them, with nothing typed again (HI-2653).
    await key.fill('hi')
    const heldBefore = !!(await lib.until(async () => (await heldKeyReads()) > 0, HUNG_MS))
    await releaseKeys()
    check('the workspace’s project has its key (hilltop: HI)', !!(await lib.until(async () => (await keyOf('hilltop'))?.key === 'HI', HUNG_MS)), JSON.stringify(await inv('project:keys')))
    check('a key typed before the projects’ keys were read is checked once they are: another project’s key', heldBefore && !!(await lib.until(async () => /HI is another project’s key/.test(await textOf(error)) && (await key.getAttribute('aria-invalid')) === 'true', HUNG_MS)), `held reads seen: ${heldBefore}, ${await boxes()}`)
    for (const [typed, why, what] of [
      ['hi', /HI is another project’s key/, "another project's key"],
      ['HIV', /HIV and HI, another project’s key, begin alike/, 'one beginning another'],
      ['H', /2 to 4 letters/, 'too short']
    ]) {
      await key.fill(typed)
      check(`a key typed is checked as it changes: ${what}, with its reason`, !!(await lib.until(async () => (await key.inputValue()) === typed.toUpperCase() && why.test(await textOf(error)) && (await key.getAttribute('aria-invalid')) === 'true', HUNG_MS)), await boxes())
    }
    const create = dialog.getByRole('button', { name: 'Create', exact: true })
    check('…and Create looks and is disabled while it can’t be one', !!(await lib.until(async () => (await create.isDisabled()) && (await create.evaluate((e) => getComputedStyle(e).opacity)) !== '1', HUNG_MS)), await create.evaluate((e) => getComputedStyle(e).opacity))
    await key.press('Enter')
    check('…Enter makes nothing either: the dialog stays, no folder', (await dialog.count()) === 1 && !fs.existsSync(path.join(ws, 'web-app')))
    await themes('newproject-error', dialog)
    await key.fill('wb')
    check('a key typed is shown in capitals; one that can be shows how its cards are named', !!(await lib.until(async () => (await key.inputValue()) === 'WB' && (await error.count()) === 0 && /WB-1, WB-2/.test(await textOf(hint)), HUNG_MS)), await boxes())
    await name.fill('web-app-2')
    // Once the name is in, the key it would have suggested (WE) is not taken up.
    check('…and the name no longer changes it once typed', !!(await lib.until(async () => (await name.inputValue()) === 'web-app-2', HUNG_MS)) && (await key.inputValue()) === 'WB', await boxes())
    await name.fill('web-app')
    await themes('newproject', dialog)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    check('Create makes the project with the key chosen', !!(await lib.until(async () => (await keyOf('web-app'))?.key === 'WB', HUNG_MS)), JSON.stringify(await keyOf('web-app')))
    // The window's Create is done once it says so: it then shows the new project's Version Control, after main has it
    // (HI-2653: under load that came after the Task Board click below, and the board was never shown).
    check('…and the window says it is created', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'Project "web-app" created' }).count()) === 1, HUNG_MS)))

    // --- Cards by key on the board.
    const c1 = await inv('tasks:create', { title: 'Login form', project: 'web-app' })
    const c2 = await inv('tasks:create', { title: 'Sign-up form', project: 'web-app' })
    const h1 = await inv('tasks:create', { title: 'Hilltop card', project: 'hilltop' })
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
    check('…and by its old number, as before', await finds(`#${h1.number}`, [h1.number]), JSON.stringify(await shown()))
    // A bare number is a key's digits, in every project (HI-1661): 1 is WB-1 and HI-1, never card #1 whatever its key.
    check('…by the digits of its key, in every project', await finds('1', [c1.number, h1.number].sort((a, b) => a - b)), JSON.stringify(await shown()))
    const stray = [h1.number, c2.number].find((n) => n > 2)
    if (stray) check('…never by the workspace number', await finds(String(stray), []), JSON.stringify({ stray, shown: await shown() }))
    await search.fill('')
    // A prompt opened from a box behind it takes the focus (round 3): typed into the search, Ctrl+Alt+N (New Project),
    // then typed again without a click, the text goes into the dialog's name, the search keeping only its own.
    await search.click()
    await page.keyboard.type('before')
    await page.keyboard.press('Control+Alt+N')
    const shortcutDialog = page.locator('.dialog', { hasText: 'New Project' })
    await shortcutDialog.waitFor({ timeout: HUNG_MS })
    const shortcutName = shortcutDialog.locator('input').first()
    await lib.until(async () => shortcutName.evaluate((e) => document.activeElement === e), HUNG_MS)
    await page.keyboard.type('typed')
    check('a prompt opened from a box behind it takes the focus: what is typed next goes into the dialog', !!(await lib.until(async () => (await shortcutName.inputValue()) === 'typed' && (await search.inputValue()) === 'before', HUNG_MS)), `[name: ${await shortcutName.inputValue()}, search: ${await search.inputValue()}]`)
    await page.keyboard.press('Escape')
    await lib.until(async () => (await shortcutDialog.count()) === 0, HUNG_MS)
    await search.fill('')

    // --- Project Settings: change the key; the old one is listed and still finds the cards.
    await page.getByRole('button', { name: 'Projects' }).click()
    await page.locator('.project-row', { hasText: 'web-app' }).first().click()
    await lib.openProjectSettings(page)
    const field = page.getByRole('textbox', { name: 'Project key', exact: true })
    await field.waitFor({ timeout: HUNG_MS })
    check('Project Settings shows the key', !!(await lib.until(async () => (await field.inputValue()) === 'WB', HUNG_MS)), await field.inputValue())
    const keyRow = page.locator('.project-key-field').locator('xpath=ancestor::*[contains(@class,"setting")][1]')
    check('…its description giving its example in the project’s own key', !!(await lib.until(async () => (await textOf(keyRow)).includes('The 2 to 4 letters this project’s cards are named by, as in WB-12. If you change it, the old key still finds them.'), HUNG_MS)), await textOf(keyRow))
    await field.fill('hi')
    check('a key taken is refused as it is typed, saying why', !!(await lib.until(async () => (await field.inputValue()) === 'HI' && /HI is another project’s key/.test(await textOf(page.locator('.project-key-field .field-error'))) && (await page.locator('.project-key-field').getByRole('button', { name: 'Change' }).isDisabled()), HUNG_MS)), await page.locator('.project-key-field').innerText())
    await field.fill('WBA')
    check('a new key says the old one keeps finding its cards', !!(await lib.until(async () => (await field.inputValue()) === 'WBA' && /WBA-12; WB-12 will still find them/.test(await textOf(page.locator('.project-key-field .field-hint'))), HUNG_MS)), await page.locator('.project-key-field').innerText())
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
    const cardDialog = page.locator('.dialog', { hasText: 'WBA-1' })
    // Its title is its key alone (HI-1661), never with the workspace number.
    check('…and choosing it opens the card, its title its key alone', !!(await lib.until(async () => (await cardDialog.count()) === 1, HUNG_MS)) && !(await cardDialog.innerText()).includes(`(#${c1.number})`), await cardDialog.innerText().catch(() => ''))
    // Depends on takes a key, the old one too.
    await cardDialog.getByPlaceholder('Cards to finish first, e.g. AM-3 AM-5').fill('WB-2')
    await cardDialog.getByRole('button', { name: 'Save', exact: true }).click()
    check('Depends on takes a card’s key, an old one too', !!(await lib.until(async () => JSON.stringify((await inv('tasks:list')).find((c) => c.number === c1.number)?.blockedBy) === JSON.stringify([c2.number]), HUNG_MS)), JSON.stringify((await inv('tasks:list')).find((c) => c.number === c1.number)?.blockedBy))
    await page.keyboard.press('Escape')
    await palette('WB-')
    check('the palette finds a project’s cards by its old key alone', !!(await lib.until(async () => (await page.locator('.palette-item', { hasText: 'Open Card: WBA-' }).count()) === 2, HUNG_MS)), await page.locator('.palette-list').innerText().catch(() => ''))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // --- A card moved to another project keeps its names in the one it left (round 1, finding 1): WBA-1 and WB-1 (its
    // project's old key) still find it in the search, the palette and Depends on, and link in a comment.
    await inv('tasks:update', c1.number, { project: 'hilltop' })
    const movedKey = await lib.until(async () => { const k = (await inv('tasks:list')).find((c) => c.number === c1.number)?.key; return k && k.startsWith('HI-') && k }, HUNG_MS)
    check('a card moved to hilltop takes its next number there', /^HI-\d+$/.test(movedKey ?? ''), movedKey)
    await page.getByRole('button', { name: 'Task Board' }).click()
    check('the board’s search finds a moved card by its name in the project it left', await finds('wba-1', [c1.number]), JSON.stringify(await shown()))
    check('…and by its project’s old key too', await finds('WB-1', [c1.number]), JSON.stringify(await shown()))
    await search.fill('')
    await palette('WB-1')
    check('the palette finds it by that name, naming it by its key now', !!(await lib.until(async () => (await page.locator('.palette-item', { hasText: `Open Card: ${movedKey} Login form` }).count()) === 1, HUNG_MS)), await page.locator('.palette-list').innerText().catch(() => ''))
    await page.keyboard.press('Escape')
    // The first Escape clears the palette's box, the second closes it.
    await page.keyboard.press('Escape')
    // Card links in Markdown (round 1, finding 3): a comment naming it by an old name and by #N links both; code doesn't.
    await inv('tasks:comment', c2.number, `Waits for WB-1 and #${c1.number}; not \`WBA-1\` in code, nor ZZ-9.`)
    await tile(c2.number).click()
    const c2Dialog = page.locator('.dialog', { hasText: 'WBA-2' })
    await c2Dialog.waitFor({ timeout: HUNG_MS })
    const refs = c2Dialog.locator('.markdown a.card-ref')
    check('a comment links the cards it names: an old key and #N, not in code or a key no card has', !!(await lib.until(async () => JSON.stringify(await refs.allInnerTexts()) === JSON.stringify(['WB-1', `#${c1.number}`]), HUNG_MS)) && (await c2Dialog.locator('.markdown code a').count()) === 0, JSON.stringify(await refs.allInnerTexts()))
    check('…each saying the card it opens', (await refs.first().getAttribute('title')) === `${movedKey} Login form`, await refs.first().getAttribute('title'))
    await refs.first().scrollIntoViewIfNeeded()
    await themes('markdown-links', refs.first().locator('xpath=ancestor::*[contains(@class,"markdown")][1]/..'))
    // Related by the moved card's old name (Depends on is the other way round already).
    await c2Dialog.getByPlaceholder('Related cards, e.g. AM-7').fill('WBA-1')
    await c2Dialog.getByRole('button', { name: 'Save', exact: true }).click()
    check('Related takes a moved card’s old name', !!(await lib.until(async () => JSON.stringify((await inv('tasks:list')).find((c) => c.number === c2.number)?.links) === JSON.stringify([c1.number]), HUNG_MS)), JSON.stringify((await inv('tasks:list')).find((c) => c.number === c2.number)?.links))
    await page.keyboard.press('Escape')
    await tile(c2.number).click()
    await c2Dialog.waitFor({ timeout: HUNG_MS })
    await c2Dialog.locator('.markdown a.card-ref').first().click()
    check('a click on a card link opens that card', !!(await lib.until(async () => (await lib.cardDialog(page, movedKey).count()) === 1, HUNG_MS)))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }

  // --- German and Polish (#1221 round 1): the new controls in the window's language, as their translations say them,
  // fitting their place. The texts are read from the locales, so a changed translation needs no change here.
  for (const lang of ['de', 'pl']) {
    const T = (area, id, values = {}) => Object.entries(values).reduce((t, [k, v]) => t.replace(`{${k}}`, v), JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', lang, `${area}.json`), 'utf8'))[id])
    const appL = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.combworkEnv({ CW_USER_DATA: userData, CW_TEST_TIPS: 'off', CW_LANG: lang }) })
    try {
      const page = await appL.firstWindow()
      await lib.fitWindow(appL, page, { width: 1400, height: 900 })
      await lib.appReady(page)
      const shot = async (name, target) => {
        for (const theme of ['dark', 'light']) {
          await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
          await target.screenshot({ path: path.join(lib.WORK, `keysui-${lang}-${name}-${theme}.png`) })
        }
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
      }
      // New Project…, from the palette by its name in this language.
      await page.keyboard.press('Control+Shift+P')
      await page.locator('.palette input').fill(T('shell', 'shell.command.project.new').replace('…', ''))
      await page.locator('.palette-item[data-command="project.new"]').first().click()
      const dialog = page.locator('.dialog', { hasText: T('actions', 'actions.project.newTitle') })
      await dialog.waitFor({ timeout: HUNG_MS })
      const key = dialog.getByRole('textbox', { name: T('actions', 'actions.project.key'), exact: true })
      const name = dialog.locator('input').first()
      const textOf = (loc) => loc.innerText({ timeout: 500 }).catch(() => '')
      const boxes = async () => `[name: ${await name.inputValue().catch(() => '?')}, key: ${await key.inputValue().catch(() => '?')}, hint: ${await textOf(dialog.locator('.field-hint'))}, error: ${await textOf(dialog.locator('.field-error'))}]`
      await name.fill('gamma-app')
      check(`${lang}: the New Project key box and its hint in ${lang}`, !!(await lib.until(async () => (await key.inputValue()) === 'GA' && (await textOf(dialog.locator('.field-hint'))) === T('actions', 'actions.project.keyHint', { first: 'GA-1', second: 'GA-2' }), HUNG_MS)), await boxes())
      await key.fill('G')
      const create = dialog.locator('.dialog-footer .btn.primary')
      check(`${lang}: …a key that can’t be one says why, and Create is off`, !!(await lib.until(async () => (await key.inputValue()) === 'G' && (await textOf(dialog.locator('.field-error'))) === T('project', 'project.key.form') && (await create.isDisabled()), HUNG_MS)), await boxes())
      const fits = await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth && [...d.querySelectorAll('.field-hint, .field-error, label')].every((e) => e.scrollWidth <= e.clientWidth + 1))
      check(`${lang}: …and it all fits the dialog`, fits)
      await shot('newproject', dialog)
      await page.keyboard.press('Escape')
      // Project Settings → Project key, with its description in this language and the project's own key.
      await page.locator('.project-row', { hasText: 'web-app' }).first().click()
      await page.keyboard.press('Alt+0')
      const field = page.locator('.project-key-field')
      await field.waitFor({ timeout: HUNG_MS })
      const row = field.locator('xpath=ancestor::*[contains(@class,"setting")][1]')
      const rowReads = (text) => text.includes(T('settings', 'settings.project.key.title')) && text.includes(T('settings', 'settings.project.key.desc', { example: 'WBA-12' })) && text.includes(T('project', 'project.key.change')) && text.includes(T('project', 'project.key.aliases', { keys: 'WB' }))
      check(`${lang}: Project key's row, its description and its button in ${lang}`, !!(await lib.until(async () => rowReads(await textOf(row)), HUNG_MS)), await textOf(row))
      await field.locator('input').fill('WBX')
      check(`${lang}: …what a new key would mean`, !!(await lib.until(async () => (await field.locator('input').inputValue()) === 'WBX' && (await textOf(field.locator('.field-hint'))) === T('project', 'project.key.willAlias', { key: 'WBX', old: 'WBA' }), HUNG_MS)), await field.innerText().catch(() => ''))
      await shot('settings', row)
      await field.locator('input').press('Escape')
    } finally {
      await appL.close()
    }
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
