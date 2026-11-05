// The connection a new agent gets (HI-2108 round 1, decision A): the first in the order of accounts whose CLI is on AND
// installed, as main's firstUsableAccount picks it. Accounts in the order Codex (on, its CLI not installed), then Claude
// Code (the fake, installed), both on here: Add Agent preselects Claude Code's connection and greys out Codex's, saying
// why; the quick add (Ctrl+Alt+Shift+N) adds the agent on Claude Code's. With no account on (HI-2127), Start a session
// now is unticked and off with its reason beside it, the agent is still added (no session), and the choice's link opens
// Settings → Accounts & Connections (screenshots in both themes). Then (round 2) both installed, Codex's detection
// held (CW_TEST_SLOW_DETECT): while it is still looked for, Add Agent chooses nothing and Add waits, saying why; an
// Add with no connection (the window's call) waits for detection in main; once Codex is found, Codex's connection is
// chosen and the agent added there. No session is started. The test seam off so the real rule applies.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'connectionfirst-profile')
const home = path.join(lib.WORK, 'connectionfirst-claude-home')
const ws = path.join(lib.WORK, 'connectionfirst-ws')
const alpha = path.join(ws, 'alpha')
const fakeUser = path.join(lib.WORK, 'connectionfirst-user')
let failed = 0
/** The accounts, connections and migration record both parts start from. */
let CONFIG = null
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, fakeUser]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  for (const d of ['AppData/Roaming', 'AppData/Local', 'codex-home']) fs.mkdirSync(path.join(fakeUser, d), { recursive: true })
  lib.gitProject(alpha)
  const env = lib.fakeClaude(userData, home, [ws, alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  const at = new Date().toISOString()
  // Already migrated (HI-2106): two accounts, Codex first in the one order, each with its base connection.
  cfg.migrations = { ...cfg.migrations, accounts1: { at, legacy: [] } }
  cfg.accounts = [
    { id: 'a-codex', provider: 'codex', kind: 'signIn', name: 'Unavailable Codex', createdAt: at },
    { id: 'a-claude', provider: 'claude-code', kind: 'signIn', name: 'Usable Claude', createdAt: at }
  ]
  cfg.connections = [
    { id: 'c-codex', account: 'a-codex', name: 'Codex first' },
    { id: 'c-claude', account: 'a-claude', name: 'Claude second' }
  ]
  cfg.settings.providers.codex = { ...cfg.settings.providers.codex, enabled: true, executablePath: '' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  CONFIG = { accounts: cfg.accounts, connections: cfg.connections, migrations: cfg.migrations }
  await settled(env)
  await duringDetection(env)
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()

/** Codex not installed: Claude Code's connection preselected and quick-added; Codex's greyed out. */
async function settled(env) {
  // Codex isn't on PATH, and its usual places are an empty throwaway user folder.
  const { app, page } = await lib.launch({
    userData,
    env: { ...env, APPDATA: path.join(fakeUser, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(fakeUser, 'AppData', 'Local'), USERPROFILE: fakeUser, HOME: fakeUser, CODEX_HOME: path.join(fakeUser, 'codex-home'), PATH: [path.dirname(process.execPath), 'C:\\Windows\\System32'].join(';'), CW_TEST_CLI_HOME_CONNECTION: '0' },
    viewport: { width: 1400, height: 900 }
  })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await inv('connections:setOn', 'a-codex', true)
    await inv('connections:setOn', 'a-claude', true)
    const found = await lib.until(async () => {
      const info = await inv('provider:info')
      return info.codex && !info.codex.checking && info['claude-code']?.found ? info : null
    }, HUNG_MS)
    check('detection: Codex not installed, the fake Claude Code installed', !!found && found.codex.found === false, JSON.stringify(found && { codex: found.codex.found, claude: found['claude-code'].found }))

    // Add Agent: Claude Code's connection preselected; Codex's listed, greyed out, saying why.
    await page.getByText('alpha', { exact: true }).first().click()
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    const add = page.locator('.dialog', { hasText: 'Add an agent' })
    const select = add.locator('#add-agent-connection')
    check('Add Agent preselects the first connection on an installed CLI (Claude second), not Codex first', !!(await lib.until(async () => (await select.count()) === 1 && (await select.inputValue()) === 'c-claude', HUNG_MS)), await select.inputValue().catch(() => ''))
    const codex = select.locator('option[value="c-codex"]')
    check("…Codex's connection greyed out, saying Codex isn't installed", (await codex.count()) === 1 && (await codex.isDisabled()) && /Codex isn't installed/.test(await codex.innerText()), await codex.innerText().catch(() => ''))
    await add.screenshot({ path: path.join(lib.WORK, 'connectionfirst-add.png') })
    const startUsable = add.locator('label', { hasText: 'Start a session now' }).locator('input')
    check('…with a usable connection, "Start a session now" stays ticked and can be changed (HI-2127)', (await startUsable.isEnabled()) && (await startUsable.isChecked()) && (await add.locator('[data-start-now-why]').count()) === 0)
    await add.getByRole('button', { name: 'Cancel', exact: true }).click()
    await lib.until(async () => (await add.count()) === 0, HUNG_MS)

    // The quick add: the agent on Claude Code's connection, its CLI Claude Code.
    const agents = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === alpha.toLowerCase())?.agents ?? []
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Alt+Shift+N')
    const added = await lib.until(async () => (await agents())[0] ?? null, HUNG_MS)
    check('the quick add puts the agent on Claude second, its CLI Claude Code', added?.connection === 'c-claude' && added.provider === 'claude-code', JSON.stringify(added && { connection: added.connection, provider: added.provider }))
    check('…and starts nothing', (await inv('session:live')).length === 0)

    // No account on here (the Assistant's ask on HI-2108): Add Agent says so with a link to Accounts & Connections, and
    // "Start a session now" is unticked and off, saying why.
    await inv('connections:setOn', 'a-codex', false)
    await inv('connections:setOn', 'a-claude', false)
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    await lib.until(async () => (await add.count()) === 1, HUNG_MS)
    const start = add.locator('label', { hasText: 'Start a session now' })
    const noAccount = add.locator('[data-no-account]')
    check('no account on here: the choice says so, with a link to Accounts & Connections', !!(await lib.until(async () => (await noAccount.count()) === 1, HUNG_MS)) && (await noAccount.locator('a', { hasText: 'Open Accounts & Connections' }).count()) === 1, await noAccount.innerText().catch(() => ''))
    check('…and "Start a session now" is unticked and off, saying why beside it', !!(await lib.until(async () => (await start.locator('input').isDisabled()) && !(await start.locator('input').isChecked()), HUNG_MS)) && (await start.locator('[data-start-now-why]').innerText().catch(() => '')).includes('No account is on here yet') && /No account is on in this workspace/.test((await start.getAttribute('title')) ?? ''), JSON.stringify({ disabled: await start.locator('input').isDisabled(), why: await start.locator('[data-start-now-why]').innerText().catch(() => ''), title: await start.getAttribute('title') }))
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await add.screenshot({ path: path.join(lib.WORK, `connectionfirst-no-account-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
    // Adding it anyway, for later: added, and no session started.
    await add.locator('input.input').first().fill('Later')
    await add.getByRole('button', { name: 'Add Agent', exact: true }).click()
    const later = await lib.until(async () => (await agents()).find((a) => a.name === 'Later') ?? null, HUNG_MS)
    check('…the agent is still added, for later, and no session starts', !!later && (await inv('session:live')).length === 0, JSON.stringify(later && { name: later.name, connection: later.connection }))
    // The link opens Settings → Accounts & Connections.
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    await lib.until(async () => (await add.locator('[data-no-account] a').count()) === 1, HUNG_MS)
    await add.locator('[data-no-account] a').click()
    check('…and its link opens Settings → Accounts & Connections', !!(await lib.until(async () => (await page.locator('.settings-nav .row.selected[data-section="accounts"]').count()) === 1, HUNG_MS)))
    if ((await add.count()) === 1) await add.getByRole('button', { name: 'Cancel', exact: true }).click()
  } catch (e) {
    check('the first part ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
}

/** Both installed, Codex's detection held: nothing decided from a guess, in the dialog or in main; Codex's once found. */
async function duringDetection(env) {
  // A profile of its own (the first part's has Codex's detection cached), with the same accounts and connections.
  const userData2 = path.join(lib.WORK, 'connectionfirst-profile-2')
  fs.rmSync(userData2, { recursive: true, force: true })
  fs.mkdirSync(userData2, { recursive: true })
  const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'))
  const fresh = { version: cfg.version, settings: { ...cfg.settings, providers: { ...cfg.settings.providers, codex: { ...cfg.settings.providers.codex, enabled: true, executablePath: path.join(__dirname, 'fake-codex', 'fake-codex.cmd') } } }, accounts: CONFIG.accounts, connections: CONFIG.connections, migrations: CONFIG.migrations }
  fs.writeFileSync(path.join(userData2, 'config.json'), JSON.stringify(fresh, null, 2))
  fs.mkdirSync(path.join(fakeUser, 'codex-home'), { recursive: true })
  // Held long enough to act while it is pending, and let go by itself: the suite waits for its end, never a time.
  // Launched as providerdetect does, not with lib.launch (which waits for detection to finish).
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ CW_USER_DATA: userData2, ...env, CODEX_HOME: path.join(fakeUser, 'codex-home'), CW_TEST_SLOW_DETECT: 'codex=20000', CW_TEST_CLI_HOME_CONNECTION: '0' }) })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.until(() => page.evaluate(() => !!document.querySelector('.app .workbench')).catch(() => false), HUNG_MS)
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    // Both on here again (the first part turned them off at its end).
    await inv('connections:setOn', 'a-codex', true)
    await inv('connections:setOn', 'a-claude', true)
    const codex = async () => (await inv('provider:info')).codex
    const pending = await lib.until(async () => {
      const info = await inv('provider:info')
      return info.codex?.checking && !info.codex.found && info['claude-code']?.found ? info : null
    }, HUNG_MS)
    const seen = await inv('provider:info')
    check('Codex is still being looked for, Claude Code found', !!pending, JSON.stringify({ codex: { found: seen.codex?.found, checking: seen.codex?.checking, path: seen.codex?.path }, claude: { found: seen['claude-code']?.found, checking: seen['claude-code']?.checking } }))

    // Add Agent while Codex is looked for: nothing chosen, Add waits, saying why.
    await page.getByText('alpha', { exact: true }).first().click()
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    const add = page.locator('.dialog', { hasText: 'Add an agent' })
    const select = add.locator('#add-agent-connection')
    const addButton = add.getByRole('button', { name: 'Add Agent', exact: true })
    await lib.until(async () => (await select.count()) === 1, HUNG_MS)
    const waiting = (await codex()).checking
    check('while Codex is looked for: no connection chosen, Add waits, saying why', waiting && (await select.inputValue()) === '' && (await addButton.isDisabled()) && (await add.locator('[data-connection-checking]').count()) === 1, JSON.stringify({ choice: await select.inputValue(), disabled: await addButton.isDisabled(), checking: waiting }))
    await add.screenshot({ path: path.join(lib.WORK, 'connectionfirst-checking.png') })

    // The window's call with no connection (as quick add's fallback, or a script), made while it is looked for: main
    // waits for detection before choosing, so it goes on Codex's.
    const viaMain = page.evaluate((p) => window.hive.invoke('agents:add', p, { name: 'Viamain' }), alpha)
    check('…an add with no connection made then waits for detection (Codex still looked for)', (await codex()).checking === true)

    // Once Codex is found: Codex first in the order, chosen; Add enabled.
    check('once Codex is found, Add Agent chooses its connection (first in the order) and Add can go', !!(await lib.until(async () => (await select.inputValue()) === 'c-codex' && !(await addButton.isDisabled()), 45000)), await select.inputValue().catch(() => ''))
    const made = await viaMain.catch((e) => ({ error: e.message }))
    check("…and main's add went on Codex's connection, its CLI Codex", made?.connection === 'c-codex' && made.provider === 'codex', JSON.stringify(made))
    await add.getByRole('button', { name: 'Cancel', exact: true }).click()
    check('…nothing started', (await inv('session:live')).length === 0)
  } catch (e) {
    check('the second part ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
}
