// Advanced settings (#367): Settings → Advanced's list (on tabs since HI-1839: Combwork (HI-2517; Hive before), then each CLI from the
// descriptors with its icon, a CLI turned off dimmed but chosen, only a tab's own values in it, remembered; filters
// counting per tab, landing on a tab with matches or a searched id's own, a click meanwhile not remembered, a tab with
// none saying so; the developer features switch first, a value not
// valid in advanced.json listed as such, an override made for another CLI version flagged with Keep), changing a value
// (marked modified, its default beside it, written to advanced.json, Reset), a value refused, advanced.json edited by
// hand (the list follows; a number written as text read as the number), the developer switch and advanced.json as one
// value, a workspace's own value (workspace.json) and its own switch inheriting Settings' (HI-2344), Agents per project gone (HI-2001), Settings' search and Modified only (Settings' and the list's), Copy
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
  // An override made for an older Claude Code, one that isn't valid, and one this Combwork doesn't know.
  fs.writeFileSync(file, JSON.stringify({ format: 1, values: { 'claude-code.trust.prompt': 'trust (this|the) folder', 'cw.mcp.replySeconds': 'soon', 'hive.someday': 1 }, madeFor: { 'claude-code.trust.prompt': { version: '2.1.0', value: 'trust (this|the) folder' } } }, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)

    // --- The list.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    const list = page.locator('.advanced-list')
    check('Settings → Advanced shows the list', !!(await lib.until(async () => (await list.count()) === 1, HUNG_MS)))
    // Tabs (HI-1839): Combwork (HI-2517), then each CLI in the providers' order, named and iconed as Settings → Providers has them.
    const tabs = () => list.locator('.advanced-tabs [role="tab"]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-tab'), label: e.querySelector('.hive-tab-label').textContent.trim(), count: e.querySelector('.hive-tab-count') ? Number(e.querySelector('.hive-tab-count').textContent.replace(/\D/g, '')) : null, selected: e.getAttribute('aria-selected') === 'true', muted: e.hasAttribute('data-muted'), name: e.getAttribute('aria-label'), icon: e.querySelector('.hive-tab-icon .provider-icon, .hive-tab-icon .tab-hex')?.getAttribute('class') ?? null })))
    const tab = (id) => list.locator(`.advanced-tabs [role="tab"][data-tab="${id}"]`)
    const selectedTab = async () => (await tabs()).find((t) => t.selected)?.id ?? null
    const configTab = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).ui?.tabs?.['settings.advanced']
    // The rows on screen: only the tab shown's, each of its group.
    const visibleIds = () => list.locator('.advanced-row').evaluateAll((rows) => rows.filter((r) => r.checkVisibility()).map((r) => r.getAttribute('data-advanced')))
    const t0 = await lib.until(async () => { const t = await tabs(); return t.length ? t : null }, HUNG_MS)
    check('tabs: Combwork, then each CLI in the providers’ order, Combwork first chosen', JSON.stringify(t0?.map((t) => t.label)) === JSON.stringify(['Combwork', 'Claude Code', 'Codex', 'GitHub Copilot']) && t0[0].selected, JSON.stringify(t0))
    check('…each with its icon: Combwork’s mark, then each CLI’s own', /tab-hex/.test(t0[0].icon ?? '') && t0.slice(1).every((t) => /provider-icon/.test(t.icon ?? '')), JSON.stringify(t0.map((t) => t.icon)))
    check('…no counts while nothing filters', t0.every((t) => t.count === null))
    const providers = (await inv('settings:get')).providers
    const enabled = (id) => !!providers?.[id]?.enabled
    check('a CLI turned off: its tab dimmed, its name saying so; one on: not', t0.slice(1).every((t) => t.muted === !enabled(t.id) && (!t.muted || /is turned off: these settings apply once you turn it on/.test(t.name ?? ''))), JSON.stringify([t0.map((t) => [t.id, t.muted, t.name]), providers]))
    const prefix = { cw: 'cw.', 'claude-code': 'claude-code.', codex: 'codex.', copilot: 'copilot.' }
    for (const t of t0) {
      await tab(t.id).click()
      check(`the ${t.label} tab shows only its own values`, !!(await lib.until(async () => { const v = await visibleIds(); return (await selectedTab()) === t.id && v.length > 5 && v.every((id) => id.startsWith(prefix[t.id])) }, HUNG_MS)), JSON.stringify((await visibleIds()).slice(0, 5)))
    }
    const muted = t0.find((t) => t.muted)
    if (muted) {
      await tab(muted.id).click()
      check('a dimmed tab is chosen as any other, its values there', !!(await lib.until(async () => (await selectedTab()) === muted.id && (await visibleIds()).length > 0, HUNG_MS)))
      // Visibly off (the Assistant's screenshot review): an "off" mark on the tab, and a line atop its values.
      const offNote = list.locator(`[role="tabpanel"][data-group="${muted.id}"] [data-note="cli-off"]`)
      check('…marked off on its tab, and its values headed by a line saying it is turned off', (await tab(muted.id).locator('.hive-tab-tag').innerText()).trim() === 'off' && (await offNote.isVisible()) && (await offNote.innerText()).includes(`${muted.label} is turned off: these settings apply once you turn it on`), await offNote.innerText().catch(() => ''))
      check('…a CLI turned on has neither', (await list.locator('.advanced-tabs [role="tab"]:not([data-muted]) .hive-tab-tag').count()) === 0 && (await list.locator('[role="tabpanel"][data-note="cli-off"], [role="tabpanel"] [data-note="cli-off"]').count()) === t0.filter((t) => t.muted).length)
      await list.locator('.advanced-tabs').scrollIntoViewIfNeeded()
      for (const theme of ['dark', 'light']) {
        await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(lib.WORK, `advanced-tabs-off-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    await tab('cw').click()
    await lib.until(async () => (await selectedTab()) === 'cw', HUNG_MS)
    const first = list.locator('.advanced-row').first()
    check('Show developer features is first, under its advanced.json name', (await first.getAttribute('data-advanced')) === 'cw.showDeveloperFeatures')
    const row = (id) => list.locator(`.advanced-row[data-advanced="${id}"]`)
    check('a value not valid in advanced.json is listed so, and the default used', /Not valid, so Combwork uses the default/.test(await row('cw.mcp.replySeconds').innerText()) && (await row('cw.mcp.replySeconds').locator('input').inputValue()) === '300')
    check("an id this Combwork doesn't know is named, not used", /hive\.someday, which this Combwork doesn't know/.test(await list.innerText()))
    const trust = row('claude-code.trust.prompt')
    await tab('claude-code').click()
    check('an override made for another Claude Code is flagged once the installed one is known', !!(await lib.until(async () => /Made for Claude Code 2\.1\.0; 2\.1\.999 is installed now/.test(await trust.innerText()), HUNG_MS)), await trust.innerText())
    check('…marked modified, with its default beside it', (await trust.locator('.modified').count()) === 1 && /Default: trust this folder/.test(await trust.innerText()))
    await page.screenshot({ path: path.join(lib.WORK, 'advanced-1-list.png') })
    await trust.getByRole('button', { name: 'Keep for 2.1.999' }).click()
    check('Keep records the installed version', !!(await lib.until(async () => readFile().madeFor['claude-code.trust.prompt']?.version === '2.1.999' && !/Made for/.test(await trust.innerText()), HUNG_MS)))

    // --- Changing one: modified, its default beside it, in advanced.json; Reset.
    await tab('cw').click()
    const reply = row('cw.mcp.replySeconds')
    await reply.locator('input').fill('600')
    await reply.locator('input').press('Enter')
    check('a change is written to advanced.json', !!(await lib.until(() => readFile().values['cw.mcp.replySeconds'] === 600, HUNG_MS)), JSON.stringify(readFile().values))
    check('…and shown modified, with the default beside it', !!(await lib.until(async () => (await reply.locator('.modified').count()) === 1 && /Default: 300 s/.test(await reply.innerText()) && !/Not valid/.test(await reply.innerText()), HUNG_MS)))
    await reply.getByRole('button', { name: /^Reset to default \(300 s\)/ }).click()
    check('Reset takes it out of advanced.json', !!(await lib.until(async () => !('cw.mcp.replySeconds' in readFile().values) && (await reply.locator('.modified').count()) === 0, HUNG_MS)))

    // --- A value refused: the box says why, the file keeps what it had.
    await tab('codex').click()
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
    edited.values['cw.mcp.replySeconds'] = '600'
    fs.writeFileSync(file, JSON.stringify(edited, null, 2))
    check('a hand edit of advanced.json shows in the list', !!(await lib.until(async () => (await row('codex.hooks.timeoutSeconds').locator('input').inputValue()) === '9' && (await row('codex.hooks.timeoutSeconds').locator('.modified').count()) === 1, HUNG_MS)))
    check('…a number written as text shows as that number, valid', (await reply.locator('input').inputValue()) === '600' && !/Not valid/.test(await reply.innerText()), await reply.locator('input').inputValue())
    // Combwork records the Codex version a hand edit was made for in the file itself.
    check('…and records in the file the Codex version it was made for', !!(await lib.until(() => readFile().madeFor?.['codex.hooks.timeoutSeconds']?.version !== undefined, HUNG_MS)), JSON.stringify(readFile().madeFor))
    fs.writeFileSync(file, '{ "values": ')
    check("a file it can't read is said so, keeping what it read", !!(await lib.until(async () => /advanced\.json isn't valid JSON/.test(await list.innerText()) && (await row('codex.hooks.timeoutSeconds').locator('input').inputValue()) === '9', HUNG_MS)))
    fs.writeFileSync(file, JSON.stringify(edited, null, 2))
    await lib.until(async () => !/isn't valid JSON/.test(await list.innerText()), HUNG_MS)

    // --- The developer switch and advanced.json are one value.
    await tab('cw').click()
    const dev = row('cw.showDeveloperFeatures')
    await dev.getByRole('switch').click()
    check('turning on Show developer features writes it to advanced.json', !!(await lib.until(() => readFile().values['cw.showDeveloperFeatures'] === true, HUNG_MS)), JSON.stringify(readFile().values))
    check('…and turns on the setting, under its own key', !!(await lib.until(async () => (await inv('settings:get')).advanced.showDeveloperFeatures === true, HUNG_MS)))
    const off = readFile()
    delete off.values['cw.showDeveloperFeatures']
    fs.writeFileSync(file, JSON.stringify(off, null, 2))
    check('taking it out of advanced.json by hand turns the setting off', !!(await lib.until(async () => (await inv('settings:get')).advanced.showDeveloperFeatures === false && (await dev.getByRole('switch').getAttribute('aria-checked')) === 'false', HUNG_MS)))

    // --- A workspace's own value (workspace.json).
    const lanes = row('cw.progress.lanesShown')
    const own = lanes.getByLabel('Progress panel: lanes shown, this workspace', { exact: false })
    await own.fill('2')
    await own.press('Enter')
    const wsFile = path.join(ws, '.combwork', 'workspace.json')
    check("a workspace's own value goes in workspace.json", !!(await lib.until(() => fs.existsSync(wsFile) && JSON.parse(fs.readFileSync(wsFile, 'utf8')).advanced?.['cw.progress.lanesShown'] === 2, HUNG_MS)))
    check('…and not in advanced.json', !('cw.progress.lanesShown' in readFile().values))
    const state = await inv('advanced:state')
    check('the window uses it', state.workspace?.['cw.progress.lanesShown'] === 2, JSON.stringify(state.workspace))
    check("Settings' own value stays beside it", (await lanes.getByLabel('Combwork: Progress panel: lanes shown', { exact: true }).inputValue()) === '6')

    // --- A workspace's own switch (HI-2344): it inherits Settings' value and shows it, takes on and off, and goes back.
    const resume = row('cw.restart.resumeAfterUpdate')
    const resumeOwn = resume.getByLabel('Combwork: Resume agents after an update, this workspace', { exact: true })
    const wsOwn = () => (fs.existsSync(wsFile) ? JSON.parse(fs.readFileSync(wsFile, 'utf8')).advanced ?? {} : {})
    const shownOwn = () => resumeOwn.evaluate((s) => s.options[s.selectedIndex].textContent)
    check("a workspace's switch untouched inherits, showing Settings' value", (await resumeOwn.inputValue()) === '' && (await shownOwn()) === "on (Settings')" && !('cw.restart.resumeAfterUpdate' in wsOwn()), await shownOwn())
    await resume.screenshot({ path: path.join(lib.WORK, 'advanced-ws-switch-inherited.png') })
    await resumeOwn.selectOption({ label: 'off' })
    check('…off goes in workspace.json as false', !!(await lib.until(() => wsOwn()['cw.restart.resumeAfterUpdate'] === false, HUNG_MS)), JSON.stringify(wsOwn()))
    check('…and the window uses it', (await inv('advanced:state')).workspace?.['cw.restart.resumeAfterUpdate'] === false)
    await resume.screenshot({ path: path.join(lib.WORK, 'advanced-ws-switch-off.png') })
    await resumeOwn.selectOption({ label: 'on' })
    check('…on as true', !!(await lib.until(() => wsOwn()['cw.restart.resumeAfterUpdate'] === true, HUNG_MS)), JSON.stringify(wsOwn()))
    await resume.screenshot({ path: path.join(lib.WORK, 'advanced-ws-switch-on.png') })
    await resumeOwn.selectOption({ index: 0 })
    check('…and Settings\' choice takes it out of workspace.json', !!(await lib.until(() => !('cw.restart.resumeAfterUpdate' in wsOwn()), HUNG_MS)), JSON.stringify(wsOwn()))
    check('…not in advanced.json either', !('cw.restart.resumeAfterUpdate' in readFile().values))
    // Inheriting again, it follows a later change of Settings' value.
    await resume.getByRole('switch').click()
    check("…inheriting, it follows Settings' value changed afterwards", !!(await lib.until(async () => readFile().values['cw.restart.resumeAfterUpdate'] === false && (await shownOwn()) === "off (Settings')" && (await resumeOwn.inputValue()) === '', HUNG_MS)), await shownOwn())
    check('…and stays out of workspace.json', !('cw.restart.resumeAfterUpdate' in wsOwn()))
    await resume.getByRole('button', { name: /^Reset to default \(on\)/ }).click()
    await lib.until(async () => !('cw.restart.resumeAfterUpdate' in readFile().values) && (await shownOwn()) === "on (Settings')", HUNG_MS)

    // --- A list of folders (HI-2480): written and shown semicolons apart (a comma can be in a folder's name), edited as
    // shown, a workspace's own over Combwork's, and an empty box back to the default (Combwork's) or to Combwork's (a workspace's).
    const folders = row('cw.cards.attachmentFolders')
    const foldersHive = folders.getByLabel('Combwork: Card attachments: more folders', { exact: true })
    const foldersOwn = folders.getByLabel('Combwork: Card attachments: more folders, this workspace', { exact: true })
    await foldersHive.fill('C:\\Evidence, runs;D:\\Runs')
    await foldersHive.press('Enter')
    check('a list of folders goes in advanced.json, a comma kept inside a folder', !!(await lib.until(() => JSON.stringify(readFile().values['cw.cards.attachmentFolders']) === JSON.stringify(['C:\\Evidence, runs', 'D:\\Runs']), HUNG_MS)), JSON.stringify(readFile().values['cw.cards.attachmentFolders']))
    // HI-2538: shown as typed, ";" alone (no space added), so editing it saves exactly the folders typed.
    check('…shown back semicolons apart, as typed', !!(await lib.until(async () => (await foldersHive.inputValue()) === 'C:\\Evidence, runs;D:\\Runs', HUNG_MS)), await foldersHive.inputValue())
    await foldersHive.fill(`${await foldersHive.inputValue()}; %LOCALAPPDATA%\\combwork-cli`)
    await foldersHive.press('Enter')
    check('…edited as shown, each folder kept apart', !!(await lib.until(() => JSON.stringify(readFile().values['cw.cards.attachmentFolders']) === JSON.stringify(['C:\\Evidence, runs', 'D:\\Runs', '%LOCALAPPDATA%\\combwork-cli']), HUNG_MS)), JSON.stringify(readFile().values['cw.cards.attachmentFolders']))
    check('…a space typed after a semicolon is trimmed, not kept or added', !!(await lib.until(async () => (await foldersHive.inputValue()) === 'C:\\Evidence, runs;D:\\Runs;%LOCALAPPDATA%\\combwork-cli', HUNG_MS)), await foldersHive.inputValue())
    // The value edited as Darren did (HI-2538): typed "a; b" saves exactly a and b, shown back "a;b", never a comma.
    await foldersHive.fill('%LOCALAPPDATA%\\combwork-cli; %LOCALAPPDATA%\\hive-test\\scratch')
    await foldersHive.press('Enter')
    check('…"a; b" saves exactly the folders typed, shown "a;b"', !!(await lib.until(async () => JSON.stringify(readFile().values['cw.cards.attachmentFolders']) === JSON.stringify(['%LOCALAPPDATA%\\combwork-cli', '%LOCALAPPDATA%\\hive-test\\scratch']) && (await foldersHive.inputValue()) === '%LOCALAPPDATA%\\combwork-cli;%LOCALAPPDATA%\\hive-test\\scratch', HUNG_MS)), `${await foldersHive.inputValue()} ${JSON.stringify(readFile().values['cw.cards.attachmentFolders'])}`)
    await folders.screenshot({ path: path.join(lib.WORK, 'advanced-folders.png') })
    await foldersOwn.fill('F:\\Workspace evidence')
    await foldersOwn.press('Enter')
    check("…a workspace's own list goes in workspace.json", !!(await lib.until(() => JSON.stringify(wsOwn()['cw.cards.attachmentFolders']) === JSON.stringify(['F:\\Workspace evidence']), HUNG_MS)), JSON.stringify(wsOwn()))
    await foldersOwn.fill('')
    await foldersOwn.press('Enter')
    check("…emptied, it goes from workspace.json: Combwork's list applies", !!(await lib.until(() => !('cw.cards.attachmentFolders' in wsOwn()), HUNG_MS)), JSON.stringify(wsOwn()))
    // HI-2537: every change reloads the advanced state, giving each list a new array. One landing while a box is being
    // typed in (the workspace's save above, late under load) reset it, so the Enter below saved nothing. Here a hand edit
    // of advanced.json reloads it while text is typed and not saved: shown in its row, the typed text is still there.
    await foldersHive.fill('C:\\Half typed')
    const typing = readFile()
    typing.values['codex.hooks.timeoutSeconds'] = 11
    fs.writeFileSync(file, JSON.stringify(typing, null, 2))
    check('…a reload while a list is being typed keeps what is typed', !!(await lib.until(async () => (await row('codex.hooks.timeoutSeconds').locator('input').inputValue()) === '11', HUNG_MS)) && (await foldersHive.inputValue()) === 'C:\\Half typed', await foldersHive.inputValue())
    await foldersHive.fill('')
    await foldersHive.press('Enter')
    check("…Combwork's emptied goes from advanced.json: the default, none", !!(await lib.until(() => !('cw.cards.attachmentFolders' in readFile().values), HUNG_MS)), JSON.stringify(readFile().values))
    await foldersHive.fill('evidence')
    await foldersHive.press('Enter')
    check('…a folder that is not a full path is refused, saying what it takes', !!(await lib.until(async () => /takes up to 20 folders, each a full path/.test(await folders.innerText()), HUNG_MS)) && !('cw.cards.attachmentFolders' in readFile().values), await folders.innerText())
    await foldersHive.fill('')
    await foldersHive.press('Enter')

    // --- Agents' temp folder (HI-2496): one folder, empty by default; two refused, saying it takes one; emptied, the default.
    const temp = row('cw.agents.tempFolder')
    const tempHive = temp.getByLabel("Combwork: Agents' temp folder", { exact: true })
    check("Agents' temp folder is listed, empty, with what it does", (await tempHive.inputValue()) === '' && /instead of Windows' Temp folder/.test(await temp.innerText()), await temp.innerText())
    await tempHive.fill('%LOCALAPPDATA%\\hive-test\\agent-tmp')
    await tempHive.press('Enter')
    check('…a folder goes in advanced.json, its variable kept', !!(await lib.until(() => JSON.stringify(readFile().values['cw.agents.tempFolder']) === JSON.stringify(['%LOCALAPPDATA%\\hive-test\\agent-tmp']), HUNG_MS)), JSON.stringify(readFile().values['cw.agents.tempFolder']))
    await temp.screenshot({ path: path.join(lib.WORK, 'advanced-tempfolder.png') })
    await tempHive.fill('D:\\a; E:\\b')
    await tempHive.press('Enter')
    check("…two folders are refused, saying it takes one folder's full path", !!(await lib.until(async () => /takes one folder's full path/.test(await temp.innerText()), HUNG_MS)) && JSON.stringify(readFile().values['cw.agents.tempFolder']) === JSON.stringify(['%LOCALAPPDATA%\\hive-test\\agent-tmp']), await temp.innerText())
    await tempHive.fill('')
    await tempHive.press('Enter')
    check('…emptied, it goes from advanced.json: the system Temp', !!(await lib.until(() => !('cw.agents.tempFolder' in readFile().values), HUNG_MS)), JSON.stringify(readFile().values))

    // Agents per project and its note moved to Version Control → Workflow (HI-2001): maxagents and agents24.
    check('Agents per project is no longer listed', (await page.locator('.advanced-row[data-advanced="hive.agents.perProject"]').count()) === 0)

    // --- Remembered (HI-1839): Codex chosen, Settings reopened on it.
    await tab('codex').click()
    check('a tab chosen is remembered in the settings', !!(await lib.until(() => configTab() === 'codex', HUNG_MS)), String(configTab()))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    check('…and Settings → Advanced opens on it again', !!(await lib.until(async () => (await selectedTab()) === 'codex', HUNG_MS)), String(await selectedTab()))

    // --- Settings' search finds them, each tab counting its matches; Modified only lists the changed ones.
    const search = page.getByRole('textbox', { name: 'Search settings' })
    await search.fill('trust question')
    check("Settings' search finds the advanced values", !!(await lib.until(async () => (await list.locator('.advanced-row').count()) === 3, HUNG_MS)), String(await list.locator('.advanced-row').count()))
    const counted = async () => (await tabs()).reduce((n, t) => n + (t.count ?? 0), 0)
    check('…each tab counting its matches, adding up to them, the remembered Codex shown (it has one)', !!(await lib.until(async () => (await counted()) === 3 && (await selectedTab()) === 'codex' && (await tabs()).find((t) => t.id === 'codex').count === (await visibleIds()).length, HUNG_MS)), JSON.stringify(await tabs()))
    await list.locator('.advanced-tabs').scrollIntoViewIfNeeded()
    for (const theme of ['dark', 'light']) {
      await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme)
      await page.mouse.move(5, 5)
      await page.screenshot({ path: path.join(lib.WORK, `advanced-tabs-search-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    // A value's own id opens its group's tab, whatever is remembered.
    await search.fill('claude-code.trust.prompt')
    check('a value’s id searched for opens its tab (Claude Code), the remembered Codex aside', !!(await lib.until(async () => (await selectedTab()) === 'claude-code' && JSON.stringify(await visibleIds()) === '["claude-code.trust.prompt"]', HUNG_MS)), JSON.stringify([await selectedTab(), await visibleIds()]))
    // A tab with no matches is still chosen, saying so honestly; a click meanwhile isn't remembered.
    await search.fill('trust question')
    const none = (await tabs()).find((t) => t.count === 0)
    await tab(none.id).click()
    check(`…a tab without matches (${none.label}) is chosen, saying it has none`, !!(await lib.until(async () => (await selectedTab()) === none.id && (await visibleIds()).length === 0 && (await list.locator(`[role="tabpanel"][data-group="${none.id}"] .empty-state`).innerText().catch(() => '')) === `No settings of ${none.label} match.`, HUNG_MS)), JSON.stringify(await tabs()))
    check('…and isn’t remembered', configTab() === 'codex', String(configTab()))
    // That choice holds for its filter only (HR5's HI-1839 round 1): the list's own filter changed without clearing
    // anything chooses again, as does a changed search for a value's id.
    await list.getByLabel('Filter advanced settings').fill('codex')
    check('…the list’s filter changed: a tab with matches again (Codex), not the one clicked', !!(await lib.until(async () => (await selectedTab()) === 'codex' && (await visibleIds()).length === 1, HUNG_MS)), JSON.stringify([await selectedTab(), await visibleIds()]))
    await list.getByLabel('Filter advanced settings').fill('')
    await tab(none.id).click()
    await lib.until(async () => (await selectedTab()) === none.id, HUNG_MS)
    await search.fill('claude-code.trust.prompt')
    check('…the search changed to a value’s id: its tab, Claude Code, not the one clicked', !!(await lib.until(async () => (await selectedTab()) === 'claude-code' && JSON.stringify(await visibleIds()) === '["claude-code.trust.prompt"]', HUNG_MS)), JSON.stringify([await selectedTab(), await visibleIds()]))
    await search.fill('trust question')
    check('…and back to the first search: chosen again, not the old click', !!(await lib.until(async () => (await selectedTab()) === 'codex', HUNG_MS)), String(await selectedTab()))
    await search.fill('')
    check('cleared: the remembered tab, Codex, is back, no counts', !!(await lib.until(async () => (await selectedTab()) === 'codex' && (await tabs()).every((t) => t.count === null), HUNG_MS)), JSON.stringify(await tabs()))
    // Settings' search, the list's own filter and both Modified only together; cleared, the remembered tab again.
    await search.fill('trust')
    await list.getByLabel('Filter advanced settings').fill('claude')
    await page.locator('.settings-top').getByLabel('Modified only').check()
    check('the search, the list’s filter and Modified only together: Claude Code’s changed trust question alone, on its tab', !!(await lib.until(async () => (await selectedTab()) === 'claude-code' && JSON.stringify(await visibleIds()) === '["claude-code.trust.prompt"]' && (await counted()) === 1, HUNG_MS)), JSON.stringify([await tabs(), await visibleIds()]))
    await page.locator('.settings-top').getByLabel('Modified only').uncheck()
    await search.fill('')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    await list.getByLabel('Filter advanced settings').fill('')
    check('…all cleared: the remembered Codex again', !!(await lib.until(async () => (await selectedTab()) === 'codex' && (await tabs()).every((t) => t.count === null), HUNG_MS)), JSON.stringify(await tabs()))
    const changedIds = 'cw.mcp.replySeconds,cw.progress.lanesShown,claude-code.trust.prompt,codex.trust.prompt,codex.hooks.timeoutSeconds'
    const ids = () => list.locator('.advanced-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-advanced')).join())
    // Settings' own Modified only, at the top, filters the list too.
    await page.locator('.settings-top').getByLabel('Modified only').check()
    check("Settings' Modified only lists only the changed advanced values", !!(await lib.until(async () => (await ids()) === changedIds, HUNG_MS)), await ids())
    check('…each tab counting its changed ones (Combwork 2, Claude Code 1, Codex 2, GitHub Copilot 0)', !!(await lib.until(async () => JSON.stringify((await tabs()).map((t) => t.count)) === '[2,1,2,0]', HUNG_MS)), JSON.stringify(await tabs()))
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
    check('Copy Diagnostics lists the overrides by name, not value', /- Advanced settings: 4 overrides \(claude-code\.trust\.prompt, codex\.hooks\.timeoutSeconds, codex\.trust\.prompt, cw\.mcp\.replySeconds\); 1 workspace value/.test(diag) && !diag.includes('trust the repository'), diag.split('\n').filter((l) => /Advanced/.test(l)).join(' / '))

    // --- Reset all settings: advanced.json's overrides too, a workspace's own kept.
    await list.getByLabel('Modified only').uncheck()
    await page.locator('.setting', { hasText: 'Reset all settings' }).getByRole('button', { name: 'Reset' }).click()
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Reset' }).click()
    check('Reset all settings clears advanced.json (keeping ids this Combwork doesn\'t know)', !!(await lib.until(() => JSON.stringify(readFile().values) === '{"hive.someday":1}', HUNG_MS)), JSON.stringify(readFile().values))
    check("…and the list shows the defaults, the workspace's own kept", !!(await lib.until(async () => (await row('codex.trust.prompt').locator('.modified').count()) === 0 && JSON.parse(fs.readFileSync(wsFile, 'utf8')).advanced?.['cw.progress.lanesShown'] === 2, HUNG_MS)))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
