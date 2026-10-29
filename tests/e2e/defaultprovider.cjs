// The default provider follows what's installed (#474).
// 1. A Codex-only install (Codex turned on, the fake Codex its CLI; Claude Code and Copilot off) on a fresh profile: the
//    default is Automatic, the empty project says nothing about Claude Code, Settings names Automatic's pick, and New
//    Session adds its first agent, a Codex one, and starts it in one click. A default the user chose that can't run
//    (Claude Code, turned off; Settings' or the project's) is named in the empty project, and Add Agent keeps it chosen,
//    says why it can't add, and adds nothing until another provider is chosen.
// 2. Claude Code turned on but not installed (hidden: a PATH without it, and a home and AppData of the suite's own, as
//    the Copilot stand-in does), Codex installed: nothing warns about Claude Code (no banner, no Provider Setup opening, a
//    plain status bar item) until an agent uses it.
// Throwaway profiles, workspace and CODEX_HOME; quiet. No real CLI is installed or signed in.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'defprov-profile')
const ws = path.join(lib.WORK, 'defprov-ws')
const codexHome = path.join(lib.WORK, 'defprov-codex-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page, inv } = await lib.launch({ userData, env: { CODEX_HOME: codexHome }, viewport: { width: 1300, height: 820 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.waitForProvider(inv, 'codex')
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `defprov-${name}.png`) })
  check('a fresh profile defaults to Automatic', (await inv('settings:get')).defaultProvider === 'auto')

  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const card = page.locator('.session-empty-card')
  check('the empty project shows its card', !!(await lib.until(async () => (await card.count()) === 1, 10000)))
  const text = await card.innerText()
  check('…saying new agents are Codex ones', text.includes('adds a Codex agent'), text)
  check('…with no warning, and nothing about Claude Code', (await card.locator('[data-provider-warning]').count()) === 0 && !text.includes('Claude Code'), text)
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await shot(`codex-only-${theme}`)
  }

  // Settings → Providers names what Automatic picks.
  await page.keyboard.press('Control+,')
  await lib.sleep(300)
  await page.locator('.settings-nav .row', { hasText: 'Providers' }).first().click()
  const picker = page.locator('.setting', { hasText: 'Default provider' }).locator('select').first()
  const shown = await lib.until(async () => ((await picker.count()) ? picker.evaluate((el) => el.selectedOptions[0]?.textContent ?? '') : null), 10000)
  check('Settings → Providers → Default provider says "Automatic (Codex)"', shown === 'Automatic (Codex)', String(shown))
  await shot('settings')
  await page.keyboard.press('Escape')
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.until(async () => (await card.count()) === 1, 10000)

  // One click: New Session adds a Codex agent and starts it.
  await card.locator('button', { hasText: 'New Session' }).click()
  const agents = async () => (await inv('workspace:get')).projects.find((p) => p.name === 'alpha')?.agents ?? []
  const added = await lib.until(async () => (await agents())[0] ?? null, 10000)
  check('New Session adds a Codex agent', added?.provider === 'codex', JSON.stringify(added))
  const live = async () => (await inv('session:live')).find((s) => s.agentId === added?.id)
  check('…and starts it', !!(await lib.until(async () => (await live())?.status === 'ready', 25000)), JSON.stringify(await live()))
  await inv('session:stop', alpha, added.id).catch(() => undefined)
  await lib.until(async () => !(await live()), 10000)
  await inv('project:updateConfig', alpha, { agents: [] })

  // A default chosen in Settings that can't run is named.
  await inv('settings:update', { defaultProvider: 'claude-code' })
  const named = await lib.until(async () => {
    const w = card.locator('[data-provider-warning]')
    return (await w.count()) === 1 ? w.innerText() : null
  }, 10000)
  check('a chosen default that is turned off is named', /Claude Code is turned off/.test(named ?? ''), String(named))
  await shot('chosen-off')

  // Add Agent keeps that choice, says why it can't add, and adds once another provider is chosen.
  const dialog = page.locator('.dialog', { hasText: 'Add an agent to alpha' })
  const addButton = () => dialog.getByRole('button', { name: 'Add Agent', exact: true })
  const addAgentDialog = async (label, whose) => {
    await card.locator('button', { hasText: 'Add Agent' }).first().click()
    const open = await lib.until(async () => (await dialog.count()) === 1, 10000)
    const checked = await dialog.locator('.provider-choice .choice.selected strong').innerText().catch(() => '')
    const note = await dialog.locator('[data-provider-off]').innerText().catch(() => '')
    check(`${label}: Add Agent keeps Claude Code chosen`, !!open && checked === 'Claude Code', checked)
    check(`${label}: …says it's turned off and is ${whose} default`, note.includes('Claude Code is turned off') && note.includes(`${whose} default provider`), note)
    check(`${label}: …and can't add it`, await addButton().isDisabled(), 'Add Agent is enabled')
    await shot(`add-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`)
  }
  await addAgentDialog('Settings default', 'your')
  await dialog.locator('.provider-choice .choice', { hasText: 'Codex' }).click()
  check('…choosing Codex instead allows Add', !(await addButton().isDisabled()) && (await dialog.locator('[data-provider-off]').count()) === 0)
  await page.keyboard.press('Escape')
  await lib.until(async () => (await dialog.count()) === 0, 5000)
  await inv('settings:update', { defaultProvider: 'auto' })
  // Automatic clears the warning first: the one the project's default brings must be a new one, not the last one still
  // shown (an Add Agent opened before the window has the project's default would start on Codex).
  await lib.until(async () => (await card.locator('[data-provider-warning]').count()) === 0, 10000)
  await inv('project:updateConfig', alpha, { defaultProvider: 'claude-code' })
  await lib.until(async () => (await card.locator('[data-provider-warning]').count()) === 1, 10000)
  check("a project's own default that is off is named too", /Claude Code is turned off/.test(await card.locator('[data-provider-warning]').innerText().catch(() => '')))
  await addAgentDialog('project default', "this project's")
  await page.keyboard.press('Escape')
  await lib.until(async () => (await dialog.count()) === 0, 5000)
  check('nothing was added meanwhile', (await agents()).length === 0, JSON.stringify(await agents()))
  await inv('project:updateConfig', alpha, { defaultProvider: 'inherit' })
  check('…and back on Automatic, no warning', !!(await lib.until(async () => (await card.locator('[data-provider-warning]').count()) === 0, 10000)))
  await app.close()

  // --- 2. Claude Code turned on but not installed, Codex installed.
  const home = path.join(lib.WORK, 'defprov-home')
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  const userData2 = path.join(lib.WORK, 'defprov-profile-2')
  fs.rmSync(userData2, { recursive: true, force: true })
  lib.enableProviders(userData2, ['claude-code', 'codex'])
  const cfg2 = JSON.parse(fs.readFileSync(path.join(userData2, 'config.json'), 'utf8'))
  cfg2.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg2.settings.general = { ...cfg2.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(path.join(userData2, 'config.json'), JSON.stringify(cfg2, null, 2))
  const base = lib.hiveEnv({ HIVE_USER_DATA: userData2 })
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === 'PATH')
  const noClaude = (base[pathKey] ?? '')
    .split(path.delimiter)
    .filter((d) => d && !['claude.exe', 'claude.cmd'].some((f) => fs.existsSync(path.join(d.replace(/^"|"$/g, ''), f))))
    .join(path.delimiter)
  const two = await lib.launch({ userData: userData2, env: { PATH: noClaude, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), CODEX_HOME: codexHome }, viewport: { width: 1300, height: 820 } })
  two.page.on('pageerror', (e) => check('no page errors', false, e.message))
  const info2 = await two.inv('provider:info')
  check('Claude Code is turned on but not found, Codex is', !info2['claude-code'].found && info2.codex.found, JSON.stringify({ claude: info2['claude-code'].path, codex: info2.codex.path }))
  await lib.openWorkspace(two.inv, two.page, ws)
  await two.page.getByText('alpha', { exact: true }).first().click()
  await lib.until(async () => (await two.page.locator('.session-empty-card').count()) === 1, 10000)
  // Hive has looked for the CLIs (launch waited for it): Provider Setup would open at once if it were going to.
  await lib.sleep(1000) // on purpose: nothing should appear
  const banners = await two.page.locator('.providers-banner').allInnerTexts()
  check('no banner about Claude Code', !banners.some((b) => b.includes('Claude Code')), JSON.stringify(banners))
  check('Provider Setup did not open by itself', (await two.page.locator('.dialog', { hasText: 'Provider Setup' }).count()) === 0)
  check('the status bar shows Claude Code plainly, not as a warning', (await two.page.locator('[data-unused-provider="claude-code"]').count()) === 1 && (await two.page.locator('.statusbar .status-item.warn', { hasText: 'Claude Code' }).count()) === 0)
  check('the empty project names Codex, with no warning', (await two.page.locator('.session-empty-card').innerText()).includes('adds a Codex agent') && (await two.page.locator('[data-provider-warning]').count()) === 0)
  await two.page.screenshot({ path: path.join(lib.WORK, 'defprov-claude-unused.png') })
  // An agent that uses Claude Code makes it a problem.
  await two.inv('agents:add', alpha, { location: 'project', provider: 'claude-code', name: 'Claudia' })
  await two.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const used = await lib.until(async () => (await two.page.locator('.providers-banner', { hasText: 'Claude Code is not installed' }).count()) === 1, 10000)
  check('once an agent uses Claude Code, its banner shows', !!used, JSON.stringify(await two.page.locator('.providers-banner').allInnerTexts()))
  await two.page.screenshot({ path: path.join(lib.WORK, 'defprov-claude-used.png') })
  await two.app.close()

  // --- 3. The providers' order (HI-1965): Claude Code and Codex both installed (the fakes), Automatic on Claude Code;
  // reordering the list in Settings → Providers (by its ⋯ menu, Alt+Up and Alt+Down, and dragging) changes what Automatic
  // picks and what the order line under it names, and the order survives a restart.
  const userData3 = path.join(lib.WORK, 'defprov-profile-3')
  const claudeHome3 = path.join(lib.WORK, 'defprov-claude-home-3')
  fs.rmSync(userData3, { recursive: true, force: true })
  lib.enableProviders(userData3, ['claude-code', 'codex'])
  const claudeEnv = lib.fakeClaude(userData3, claudeHome3)
  const cfg3 = JSON.parse(fs.readFileSync(path.join(userData3, 'config.json'), 'utf8'))
  cfg3.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg3.settings.general = { ...cfg3.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(path.join(userData3, 'config.json'), JSON.stringify(cfg3, null, 2))
  const openProviders = async (run) => {
    await lib.waitForProvider(run.inv, 'codex')
    await lib.waitForProvider(run.inv, 'claude-code')
    await run.page.keyboard.press('Control+,')
    await run.page.locator('.settings-nav .row', { hasText: 'Providers' }).first().click()
    await lib.until(async () => (await run.page.locator('.provider-list .provider-row').count()) === 3, 10000)
  }
  const orderOf = (run) => run.page.locator('.provider-list').getAttribute('data-order')
  const automatic = (run) => run.page.locator('.setting', { hasText: 'Default provider' }).locator('select').first().evaluate((el) => el.selectedOptions[0]?.textContent ?? '')
  const orderLine = (run) => run.page.locator('.default-provider-order').innerText().catch(() => '')
  const three = await lib.launch({ userData: userData3, env: { ...claudeEnv, CODEX_HOME: codexHome }, viewport: { width: 1300, height: 820 } })
  three.page.on('pageerror', (e) => check('no page errors', false, e.message))
  await openProviders(three)
  check("Hive's order at first, Automatic on Claude Code", (await orderOf(three)) === 'claude-code,codex,copilot' && (await automatic(three)) === 'Automatic (Claude Code)', `${await orderOf(three)} ${await automatic(three)}`)
  check('…and the line under it names the order', (await orderLine(three)) === 'Automatic tries Claude Code and Codex, in that order.', await orderLine(three))
  // Codex's ⋯ menu: Move Up.
  const row = (id) => three.page.locator(`.provider-row[data-provider="${id}"]`)
  await row('codex').getByRole('button', { name: 'More for Codex' }).click()
  const menuUp = three.page.locator('.menu .menu-item', { hasText: 'Move Up' })
  check("a row's ⋯ menu offers Move Up and Move Down", !!(await lib.until(async () => (await menuUp.count()) === 1, 5000)) && (await three.page.locator('.menu .menu-item', { hasText: 'Move Down' }).count()) === 1)
  await menuUp.click()
  const moved = await lib.until(async () => (await orderOf(three)) === 'codex,claude-code,copilot' && (await automatic(three)) === 'Automatic (Codex)', 10000)
  check('Move Up puts Codex first: Automatic picks Codex', !!moved, `${await orderOf(three)} ${await automatic(three)}`)
  check('…the order line follows', (await orderLine(three)) === 'Automatic tries Codex and Claude Code, in that order.', await orderLine(three))
  check('…and Settings saves it', JSON.stringify((await three.inv('settings:get')).providerOrder) === JSON.stringify(['codex', 'claude-code', 'copilot']), JSON.stringify((await three.inv('settings:get')).providerOrder))
  // Keys: Alt+Down on Codex's row takes it back down.
  await row('codex').focus()
  await three.page.keyboard.press('Alt+ArrowDown')
  check('Alt+Down moves the focused row down: Automatic back on Claude Code', !!(await lib.until(async () => (await orderOf(three)) === 'claude-code,codex,copilot' && (await automatic(three)) === 'Automatic (Claude Code)', 10000)), `${await orderOf(three)} ${await automatic(three)}`)
  // Dragging GitHub Copilot to the top.
  await row('copilot').dragTo(row('claude-code'))
  check('dragging a row onto another puts it there', !!(await lib.until(async () => (await orderOf(three)) === 'copilot,claude-code,codex', 10000)), await orderOf(three))
  // Copilot is off: Automatic skips it. Codex above Claude Code again, for the restart.
  await three.inv('settings:update', { providerOrder: ['copilot', 'codex', 'claude-code'] })
  check('a provider turned off is skipped: Automatic on Codex', !!(await lib.until(async () => (await automatic(three)) === 'Automatic (Codex)', 10000)), await automatic(three))
  for (const theme of ['dark', 'light']) {
    await three.inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await three.page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme, 5000)
    await three.page.locator('.settings-content').first().screenshot({ path: path.join(lib.WORK, `defprov-order-${theme}.png`) }).catch(() => three.page.screenshot({ path: path.join(lib.WORK, `defprov-order-${theme}.png`) }))
  }
  await three.app.close()
  // After a restart: the same order, and Automatic still on Codex. Its first two saves slow (HR2's round 1), for moves made
  // faster than they save.
  const again = await lib.launch({ userData: userData3, env: { ...claudeEnv, CODEX_HOME: codexHome, HIVE_TEST_SLOW_IPC: 'settings:update=1200*2' }, viewport: { width: 1300, height: 820 } })
  again.page.on('pageerror', (e) => check('no page errors', false, e.message))
  await openProviders(again)
  check('after a restart: the same order, Automatic on Codex', (await orderOf(again)) === 'copilot,codex,claude-code' && (await automatic(again)) === 'Automatic (Codex)', `${await orderOf(again)} ${await automatic(again)}`)
  // Settings' provider pages and Advanced's CLI tabs follow the order too (HR2's round 1), the other sections where they were.
  const navOrder = () => again.page.locator('.settings-nav .row[data-section^="provider:"]').evaluateAll((els) => els.map((e) => e.dataset.section.replace('provider:', '')).join(','))
  check("Settings' provider pages follow the order", (await navOrder()) === 'copilot,codex,claude-code', await navOrder())
  await again.page.locator('.settings-nav .row', { hasText: 'Advanced' }).first().click()
  const tabOrder = () => again.page.locator('.advanced-tabs [data-tab]').evaluateAll((els) => els.map((e) => e.dataset.tab).join(','))
  const tabs = await lib.until(async () => ((await again.page.locator('.advanced-tabs [data-tab]').count()) > 1 ? tabOrder() : null), 10000)
  const want = ['hive', 'copilot', 'codex', 'claude-code'].filter((g) => (tabs ?? '').split(',').includes(g)).join(',')
  check("Advanced's CLI tabs follow it, Hive's first", !!tabs && tabs === want && tabs.startsWith('hive,'), String(tabs))
  await again.page.locator('.settings-nav .row', { hasText: 'Providers' }).first().click()
  await lib.until(async () => (await again.page.locator('.provider-list .provider-row').count()) === 3, 10000)
  // Two moves before either save is back: both kept, shown at once and saved in the end.
  await again.page.locator('.provider-row[data-provider="copilot"]').focus()
  await again.page.keyboard.press('Alt+ArrowDown')
  await again.page.keyboard.press('Alt+ArrowDown')
  check('two quick moves show at once', !!(await lib.until(async () => (await orderOf(again)) === 'codex,claude-code,copilot', 5000)), await orderOf(again))
  const savedOrder = async () => JSON.stringify((await again.inv('settings:get')).providerOrder)
  check('…and both are saved, in order, though the saves are slow', !!(await lib.until(async () => (await savedOrder()) === JSON.stringify(['codex', 'claude-code', 'copilot']) && (await orderOf(again)) === 'codex,claude-code,copilot', 15000)), `${await savedOrder()} ${await orderOf(again)}`)
  await again.app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
