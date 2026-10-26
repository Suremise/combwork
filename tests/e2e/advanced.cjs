// Advanced settings (#367): Settings → Advanced's list (grouped, the developer features switch first, a value not
// valid in advanced.json listed as such, an override made for another CLI version flagged with Keep), changing a value
// (marked modified, its default beside it, written to advanced.json, Reset), a value refused, advanced.json edited by
// hand (the list follows; a number written as text read as the number), the developer switch and advanced.json as one
// value, a workspace's own value (workspace.json), Agents per project's note above 12 (#562), Settings' search and Modified only (Settings' and the list's), Copy
// Diagnostics, and Reset all settings clearing advanced.json. The fake Claude Code (2.1.999) is the installed CLI; no
// agent runs. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'advanced-profile')
const claudeHome = path.join(lib.WORK, 'advanced-claude-home')
const ws = path.join(lib.WORK, 'advanced-ws')
const alpha = path.join(ws, 'alpha')
const file = path.join(userData, 'advanced.json')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'))

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  const claudeEnv = lib.fakeClaude(userData, claudeHome)
  // An override made for an older Claude Code, one that isn't valid, and one this Hive doesn't know.
  fs.writeFileSync(file, JSON.stringify({ format: 1, values: { 'claude-code.trust.prompt': 'trust (this|the) folder', 'hive.mcp.replySeconds': 'soon', 'hive.someday': 1 }, madeFor: { 'claude-code.trust.prompt': { version: '2.1.0', value: 'trust (this|the) folder' } } }, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)

    // --- The list.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    const list = page.locator('.advanced-list')
    check('Settings → Advanced shows the list', !!(await lib.until(async () => (await list.count()) === 1, HUNG_MS)))
    const groups = await list.locator('.advanced-group h3').allInnerTexts()
    check('grouped: Hive, then each CLI', groups.join('|').toLowerCase() === 'hive|claude code|codex|github copilot', groups.join('|'))
    const first = list.locator('.advanced-row').first()
    check('Show developer features is first, under its advanced.json name', (await first.getAttribute('data-advanced')) === 'hive.showDeveloperFeatures')
    const row = (id) => list.locator(`.advanced-row[data-advanced="${id}"]`)
    check('a value not valid in advanced.json is listed so, and the default used', /Not valid, so Hive uses the default/.test(await row('hive.mcp.replySeconds').innerText()) && (await row('hive.mcp.replySeconds').locator('input').inputValue()) === '300')
    check("an id this Hive doesn't know is named, not used", /hive\.someday, which this Hive doesn't know/.test(await list.innerText()))
    const trust = row('claude-code.trust.prompt')
    check('an override made for another Claude Code is flagged once the installed one is known', !!(await lib.until(async () => /Made for Claude Code 2\.1\.0; 2\.1\.999 is installed now/.test(await trust.innerText()), HUNG_MS)), await trust.innerText())
    check('…marked modified, with its default beside it', (await trust.locator('.modified').count()) === 1 && /Default: trust this folder/.test(await trust.innerText()))
    await page.screenshot({ path: path.join(lib.WORK, 'advanced-1-list.png') })
    await trust.getByRole('button', { name: 'Keep for 2.1.999' }).click()
    check('Keep records the installed version', !!(await lib.until(async () => readFile().madeFor['claude-code.trust.prompt']?.version === '2.1.999' && !/Made for/.test(await trust.innerText()), HUNG_MS)))

    // --- Changing one: modified, its default beside it, in advanced.json; Reset.
    const reply = row('hive.mcp.replySeconds')
    await reply.locator('input').fill('600')
    await reply.locator('input').press('Enter')
    check('a change is written to advanced.json', !!(await lib.until(() => readFile().values['hive.mcp.replySeconds'] === 600, HUNG_MS)), JSON.stringify(readFile().values))
    check('…and shown modified, with the default beside it', !!(await lib.until(async () => (await reply.locator('.modified').count()) === 1 && /Default: 300 s/.test(await reply.innerText()) && !/Not valid/.test(await reply.innerText()), HUNG_MS)))
    await reply.getByRole('button', { name: /^Reset to default \(300 s\)/ }).click()
    check('Reset takes it out of advanced.json', !!(await lib.until(async () => !('hive.mcp.replySeconds' in readFile().values) && (await reply.locator('.modified').count()) === 0, HUNG_MS)))

    // --- A value refused: the box says why, the file keeps what it had.
    const codexTrust = row('codex.trust.prompt').locator('input')
    await codexTrust.fill('trust (this')
    await codexTrust.press('Enter')
    check("a pattern that doesn't compile is refused, saying why", !!(await lib.until(async () => /isn't a valid regular expression/.test(await row('codex.trust.prompt').innerText()), HUNG_MS)))
    check('…and not written', !('codex.trust.prompt' in readFile().values))
    // A pattern that no longer finds what Codex was recorded showing is kept, and says so.
    await codexTrust.fill('trust the repository')
    await codexTrust.press('Enter')
    check("a value that doesn't find what the CLI was recorded showing is kept, and says so", !!(await lib.until(async () => readFile().values['codex.trust.prompt'] === 'trust the repository' && /doesn't find what Codex 0\.162\.1 showed/.test(await row('codex.trust.prompt').innerText()), HUNG_MS)))

    // --- advanced.json edited by hand: the list follows.
    const edited = readFile()
    edited.values['codex.hooks.timeoutSeconds'] = 9
    // A number written as text is read as the number, and shown so.
    edited.values['hive.mcp.replySeconds'] = '600'
    fs.writeFileSync(file, JSON.stringify(edited, null, 2))
    check('a hand edit of advanced.json shows in the list', !!(await lib.until(async () => (await row('codex.hooks.timeoutSeconds').locator('input').inputValue()) === '9' && (await row('codex.hooks.timeoutSeconds').locator('.modified').count()) === 1, HUNG_MS)))
    check('…a number written as text shows as that number, valid', (await reply.locator('input').inputValue()) === '600' && !/Not valid/.test(await reply.innerText()), await reply.locator('input').inputValue())
    // Hive records the Codex version a hand edit was made for in the file itself.
    check('…and records in the file the Codex version it was made for', !!(await lib.until(() => readFile().madeFor?.['codex.hooks.timeoutSeconds']?.version !== undefined, HUNG_MS)), JSON.stringify(readFile().madeFor))
    fs.writeFileSync(file, '{ "values": ')
    check("a file it can't read is said so, keeping what it read", !!(await lib.until(async () => /advanced\.json isn't valid JSON/.test(await list.innerText()) && (await row('codex.hooks.timeoutSeconds').locator('input').inputValue()) === '9', HUNG_MS)))
    fs.writeFileSync(file, JSON.stringify(edited, null, 2))
    await lib.until(async () => !/isn't valid JSON/.test(await list.innerText()), HUNG_MS)

    // --- The developer switch and advanced.json are one value.
    const dev = row('hive.showDeveloperFeatures')
    await dev.getByRole('switch').click()
    check('turning on Show developer features writes it to advanced.json', !!(await lib.until(() => readFile().values['hive.showDeveloperFeatures'] === true, HUNG_MS)), JSON.stringify(readFile().values))
    check('…and turns on the setting, under its own key', !!(await lib.until(async () => (await inv('settings:get')).advanced.showDeveloperFeatures === true, HUNG_MS)))
    const off = readFile()
    delete off.values['hive.showDeveloperFeatures']
    fs.writeFileSync(file, JSON.stringify(off, null, 2))
    check('taking it out of advanced.json by hand turns the setting off', !!(await lib.until(async () => (await inv('settings:get')).advanced.showDeveloperFeatures === false && (await dev.getByRole('switch').getAttribute('aria-checked')) === 'false', HUNG_MS)))

    // --- A workspace's own value (workspace.json).
    const lanes = row('hive.progress.lanesShown')
    const own = lanes.getByLabel('Progress panel: lanes shown, this workspace', { exact: false })
    await own.fill('2')
    await own.press('Enter')
    const wsFile = path.join(ws, '.hive', 'workspace.json')
    check("a workspace's own value goes in workspace.json", !!(await lib.until(() => fs.existsSync(wsFile) && JSON.parse(fs.readFileSync(wsFile, 'utf8')).advanced?.['hive.progress.lanesShown'] === 2, HUNG_MS)))
    check('…and not in advanced.json', !('hive.progress.lanesShown' in readFile().values))
    const state = await inv('advanced:state')
    check('the window uses it', state.workspace?.['hive.progress.lanesShown'] === 2, JSON.stringify(state.workspace))
    check("Settings' own value stays beside it", (await lanes.getByLabel('Hive: Progress panel: lanes shown', { exact: true }).inputValue()) === '6')

    // --- Agents per project (#562): above 12, a note on what more agents cost, in this computer's figures.
    const agentsRow = row('hive.agents.perProject')
    const note = agentsRow.locator('[data-note="many-agents"]')
    check('Agents per project: 12, and no note', (await agentsRow.getByLabel('Hive: Agents per project', { exact: true }).inputValue()) === '12' && (await note.count()) === 0)
    const agentsOwn = agentsRow.getByLabel('Agents per project, this workspace', { exact: false })
    await agentsOwn.fill('20')
    await agentsOwn.press('Enter')
    const noteText = async () => ((await note.count()) ? await note.innerText() : '')
    check("this workspace at 20: a note on memory and the plans' limits, with this computer's figures", !!(await lib.until(async () => /this computer has \d+\.\d GB of memory, \d+(\.\d)? [GM]B free\. They all share your plans' usage limits/.test(await noteText()), HUNG_MS)), await noteText())
    check('…in workspace.json, the limit Hive uses here', !!(await lib.until(async () => (await inv('advanced:state')).workspace?.['hive.agents.perProject'] === 20, HUNG_MS)))
    await agentsRow.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(lib.WORK, 'advanced-4-agents.png') })
    await agentsOwn.fill('25')
    await agentsOwn.press('Enter')
    check('25 is refused: 24 at the most', !!(await lib.until(async () => /24/.test(await agentsRow.locator('.field-error').innerText().catch(() => '')), HUNG_MS)), await agentsRow.innerText())
    await agentsOwn.fill('')
    await agentsOwn.press('Enter')
    check('emptied: Settings\' 12 again, and no note', !!(await lib.until(async () => (await inv('advanced:state')).workspace?.['hive.agents.perProject'] === undefined && (await note.count()) === 0, HUNG_MS)))

    // --- Settings' search finds them; Modified only lists the changed ones.
    await page.getByRole('textbox', { name: 'Search settings' }).fill('trust question')
    check("Settings' search finds the advanced values", !!(await lib.until(async () => (await list.locator('.advanced-row').count()) === 3, HUNG_MS)), String(await list.locator('.advanced-row').count()))
    await page.screenshot({ path: path.join(lib.WORK, 'advanced-2-search.png') })
    await page.getByRole('textbox', { name: 'Search settings' }).fill('')
    const changedIds = 'hive.mcp.replySeconds,hive.progress.lanesShown,claude-code.trust.prompt,codex.trust.prompt,codex.hooks.timeoutSeconds'
    const ids = () => list.locator('.advanced-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-advanced')).join())
    // Settings' own Modified only, at the top, filters the list too.
    await page.locator('.settings-top').getByLabel('Modified only').check()
    check("Settings' Modified only lists only the changed advanced values", !!(await lib.until(async () => (await ids()) === changedIds, HUNG_MS)), await ids())
    await page.locator('.settings-top').getByLabel('Modified only').uncheck()
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    await list.getByLabel('Modified only').check()
    check("the list's own Modified only lists the changed ones", !!(await lib.until(async () => (await ids()) === changedIds, HUNG_MS)), await ids())

    // --- Light theme, for the screenshot.
    await inv('settings:update', { appearance: { theme: 'light' } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes('light'), HUNG_MS)
    await page.screenshot({ path: path.join(lib.WORK, 'advanced-3-light.png') })

    // --- Copy Diagnostics names them, never their values.
    const diag = await inv('app:diagnostics')
    check('Copy Diagnostics lists the overrides by name, not value', /- Advanced settings: 4 overrides \(claude-code\.trust\.prompt, codex\.hooks\.timeoutSeconds, codex\.trust\.prompt, hive\.mcp\.replySeconds\); 1 workspace value/.test(diag) && !diag.includes('trust the repository'), diag.split('\n').filter((l) => /Advanced/.test(l)).join(' / '))

    // --- Reset all settings: advanced.json's overrides too, a workspace's own kept.
    await list.getByLabel('Modified only').uncheck()
    await page.locator('.setting', { hasText: 'Reset all settings' }).getByRole('button', { name: 'Reset' }).click()
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Reset' }).click()
    check('Reset all settings clears advanced.json (keeping ids this Hive doesn\'t know)', !!(await lib.until(() => JSON.stringify(readFile().values) === '{"hive.someday":1}', HUNG_MS)), JSON.stringify(readFile().values))
    check("…and the list shows the defaults, the workspace's own kept", !!(await lib.until(async () => (await row('codex.trust.prompt').locator('.modified').count()) === 0 && JSON.parse(fs.readFileSync(wsFile, 'utf8')).advanced?.['hive.progress.lanesShown'] === 2, HUNG_MS)))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
