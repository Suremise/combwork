// The default provider follows what's installed (#474).
// 1. A Codex-only install (Codex turned on, the fake Codex its CLI; Claude Code and Copilot off) on a fresh profile: the
//    default is Automatic, the empty project says nothing about Claude Code, and New
//    Session adds its first agent, a Codex one, and starts it in one click. A 0.9 config's chosen default (Claude Code,
//    turned off) is read by nothing (decision A, HI-2132): the empty project doesn't name it, and Add Agent offers
//    connections, with no provider to keep chosen.
// 2. Claude Code turned on but not installed (hidden: a PATH without it, and a home and AppData of the suite's own, as
//    the Copilot stand-in does), Codex installed: nothing warns about Claude Code (no banner, no Provider Setup opening, a
//    plain status bar item) until an agent uses it.
// Settings → Providers' Default provider and the providers' order went with HI-2107 (decision A: the one order of accounts).
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

  // A 0.9 config's chosen default (Claude Code, turned off) is read by nothing since decision A (HI-2132): the empty
  // project still names Codex and warns of nothing.
  await inv('settings:update', { defaultProvider: 'claude-code' })
  check('a 0.9 chosen default is not named', !!(await lib.until(async () => (await card.locator('[data-provider-warning]').count()) === 0 && (await card.innerText()).includes('adds a Codex agent'), 10000)), await card.innerText())
  await shot('chosen-off')

  // Add Agent has no provider to choose (HI-2108, decision A): it offers connections, and Settings' old default doesn't
  // keep Claude Code chosen there; adding stays possible.
  const dialog = page.locator('.dialog', { hasText: 'Add an agent to alpha' })
  const addButton = () => dialog.getByRole('button', { name: 'Add Agent', exact: true })
  await card.locator('button', { hasText: 'Add Agent' }).first().click()
  check('Add Agent opens', !!(await lib.until(async () => (await dialog.count()) === 1, 10000)))
  check('…with a connection to choose and no coding agent choice', (await dialog.locator('#add-agent-connection').count()) === 1 && (await dialog.locator('.provider-choice').count()) === 0 && (await dialog.locator('[data-provider-off]').count()) === 0)
  check('…and can add', !(await addButton().isDisabled()))
  await shot('add-agent')
  await page.keyboard.press('Escape')
  await lib.until(async () => (await dialog.count()) === 0, 5000)
  await inv('settings:update', { defaultProvider: 'auto' })
  check('nothing was added meanwhile', (await agents()).length === 0, JSON.stringify(await agents()))
  // A project has no default provider of its own any more (HI-2106, decision A): one sent is not kept.
  await inv('project:updateConfig', alpha, { defaultProvider: 'claude-code' })
  check("…a project's own default isn't kept, and Automatic warns of nothing", !JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8')).defaultProvider && !!(await lib.until(async () => (await card.locator('[data-provider-warning]').count()) === 0, 10000)))
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
  // Combwork has looked for the CLIs (launch waited for it): Provider Setup would open at once if it were going to.
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

  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
