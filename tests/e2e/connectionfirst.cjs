// The connection a new agent gets (HI-2108 round 1, decision A): the first in the order of accounts whose CLI is on AND
// installed, as main's firstUsableAccount picks it. Accounts in the order Codex (on, its CLI not installed), then Claude
// Code (the fake, installed), both on here: Add Agent preselects Claude Code's connection and greys out Codex's, saying
// why; the quick add (Ctrl+Alt+Shift+N) adds the agent on Claude Code's. No session is started. The test seam off so
// the real rule applies; Codex hidden from PATH and given no path.
const lib = require('./lib.cjs')
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

  // Codex isn't on PATH, and its usual places are an empty throwaway user folder.
  const { app, page } = await lib.launch({
    userData,
    env: { ...env, APPDATA: path.join(fakeUser, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(fakeUser, 'AppData', 'Local'), USERPROFILE: fakeUser, HOME: fakeUser, CODEX_HOME: path.join(fakeUser, 'codex-home'), PATH: [path.dirname(process.execPath), 'C:\\Windows\\System32'].join(';'), HIVE_TEST_CLI_HOME_CONNECTION: '0' },
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
    await add.getByRole('button', { name: 'Cancel', exact: true }).click()
    await lib.until(async () => (await add.count()) === 0, HUNG_MS)

    // The quick add: the agent on Claude Code's connection, its CLI Claude Code.
    const agents = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === alpha.toLowerCase())?.agents ?? []
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Alt+Shift+N')
    const added = await lib.until(async () => (await agents())[0] ?? null, HUNG_MS)
    check('the quick add puts the agent on Claude second, its CLI Claude Code', added?.connection === 'c-claude' && added.provider === 'claude-code', JSON.stringify(added && { connection: added.connection, provider: added.provider }))
    check('…and starts nothing', (await inv('session:live')).length === 0)
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
