// A session whose model Combwork has no price for has an unknown cost, never $0: the agent's footer shows "$?", the
// Overview's running agent and its cost cards "Unknown" (the summary, the provider's, the session's),
// each naming the model on hover; with a price of the user's they show the estimate. The agent is the fake Claude
// Code, whose transcript reports the model "claude-fake" and no cost. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'unpricedcost-profile')
const ws = path.join(lib.WORK, 'unpricedcost-ws')
const claudeHome = path.join(lib.WORK, 'unpricedcost-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47928), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Counter' })
  const key = lib.ptyKey(alpha, agent.id)
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 20000)))
  await inv('pty:write', key, 'hello')
  await lib.sleep(100)
  await inv('pty:write', key, '\r')
  check('it answers', !!(await until(async () => (await live())?.status === 'finished', 10000)))

  // --- The agent's footer: $?, saying which model has no price and where to add one.
  const footer = page.locator('.pane-footer-bar').first()
  const unknown = footer.locator('.pane-foot-item', { hasText: '$?' })
  check('footer: the cost is $?', !!(await until(() => unknown.isVisible().catch(() => false), 10000)), await footer.innerText().catch(() => ''))
  await unknown.hover()
  const tip = page.locator('.tip', { hasText: 'claude-fake' }).last()
  check('…naming the model and API prices on hover', !!(await until(async () => /no API price for claude-fake.*API prices/s.test((await tip.innerText().catch(() => '')) || ''), 5000)))
  check('footer: never $0', !/\$0\.00/.test(await footer.innerText()))
  await page.mouse.move(0, 0)
  await page.screenshot({ path: path.join(lib.WORK, 'unpricedcost-1-footer.png') })

  // --- The Overview: Running now, the summary, the provider's card and the session's.
  await page.locator('.tab', { hasText: 'Overview' }).click()
  const costCards = page.locator('.card', { has: page.locator('h3', { hasText: 'API-equivalent cost' }) })
  const values = async () => (await costCards.locator('.value').allInnerTexts().catch(() => [])).map((s) => s.trim())
  check('Overview: every cost card says Unknown', !!(await until(async () => (await values()).length >= 3 && (await values()).every((v) => v === 'Unknown'), 10000)), JSON.stringify(await values()))
  check('…none says $0.00', !(await values()).some((v) => v.includes('$0')))
  const running = page.locator('.running-row').first()
  check('Running now: Unknown', !!(await until(async () => /Unknown/.test(await running.innerText().catch(() => '')), 5000)), await running.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'unpricedcost-2-overview.png') })

  // --- The Workspace Overview: its summary, the project's row and the provider's card.
  await page.keyboard.press('Control+Shift+O')
  check('Workspace Overview: its cost cards say Unknown', !!(await until(async () => (await page.locator('h1', { hasText: 'Workspace Overview' }).count()) === 1 && (await values()).length >= 2 && (await values()).every((v) => v === 'Unknown'), 10000)), JSON.stringify(await values()))
  const row = page.locator('.ws-projects tbody tr', { hasText: 'alpha' })
  check("…and the project's row", /Unknown/.test(await row.innerText().catch(() => '')) && !/\$0\.00/.test(await row.innerText().catch(() => '')), await row.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'unpricedcost-3-workspace.png') })
  await page.getByText('alpha', { exact: true }).first().click()

  // --- With a price of the user's, the same places show the estimate.
  await inv('settings:setProviderPrices', 'claude-code', { 'claude-fake': { input: 1000, cachedInput: 100, cacheWrite: 1000, output: 1000 } })
  await page.reload()
  await lib.appReady(page)
  await page.locator('.tab', { hasText: 'Overview' }).click()
  check('priced: the cost cards show an estimate', !!(await until(async () => (await values()).length >= 3 && (await values()).every((v) => /^≈\s\$\d/.test(v)), 15000)), JSON.stringify(await values()))
  check('…and Running now', !!(await until(async () => /≈\s\$\d/.test(await running.innerText().catch(() => '')), 10000)), await running.innerText().catch(() => ''))
  await page.locator('.tab', { hasText: 'Session' }).first().click()
  check('…and the footer', !!(await until(async () => /≈\$\d/.test(await footer.innerText().catch(() => '')) && !(await unknown.count()), 10000)), await footer.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'unpricedcost-4-priced.png') })

  // --- A click on the cost opens the Overview at this session's details, its agent picked (#122); its tooltip says so.
  const cost = footer.locator('.foot-cost')
  await cost.hover()
  const costTip = page.locator('.tip', { hasText: 'API-equivalent cost' }).last()
  check("the cost's tooltip ends with what a click does", !!(await until(async () => ((await costTip.innerText().catch(() => '')) || '').endsWith("\n\nClick to see this session's details in the Overview"), 5000)), await costTip.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'unpricedcost-5-cost-tip.png') })
  await cost.click()
  const head = page.locator('.session-head')
  check('a click opens the Overview', !!(await until(async () => (await page.locator('.tab.active', { hasText: 'Overview' }).count()) === 1, 5000)))
  check("…at this session's details, in view (its agent picked when there are several)", !!(await until(async () => (await head.count()) === 1 && (await head.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight - 100 })), 5000)) && ((await head.locator('select').count()) === 0 || (await head.locator('select').inputValue()) === agent.id), await head.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'unpricedcost-6-session.png') })

  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
