// An account's usage move (HI-2195), end to end with the fake Claude Code (the test seam off, no browser): two accounts
// signed in through the fake, each with a "Main" and a "Builder" connection; Max 1's rule moves its agents to Max 2 at 90%
// of its weekly limit. One (running, idle, on Max 1's Builder) reports Max 1's limits at 95% weekly ("planusage F W", as
// Claude Code's status line does): it is switched to Max 2's Builder and resumed, and Two (stopped, on Max 1's Main) is
// moved to Max 2's Main at once; a notice names who moved. The workspace's Hive Assistant, on Max 1 too, stays there. Nothing moves back when Max 1 reads low again. Screenshots of
// the rule in Settings → Accounts & Connections, in both themes, and the Assistant's view of it (cw_connection list's
// usage, through GET /v1/connections).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
const PORT = Number(lib.port(47699))

const userData = path.join(lib.WORK, 'usagemove-profile')
const home = path.join(lib.WORK, 'usagemove-claude-home')
const ws = path.join(lib.WORK, 'usagemove-ws')
const alpha = path.join(ws, 'alpha')
const accountsRoot = path.join(userData, 'accounts')
const notifyLog = path.join(lib.WORK, 'usagemove-notify.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, notifyLog]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha])
  // The Agent API on, for the Assistant's view (GET /v1/connections with the workspace token).
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }, { id: 'a-two', name: 'Two' }] }))

  const { app, page, inv } = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_CLI_HOME_CONNECTION: '0', HIVE_TEST_NOTIFY_LOG: notifyLog }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    const rows = async () => (await inv('connections:list')).connectionRows
    const agentConnection = async (id) => JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8')).agents.find((a) => a.id === id)?.connection

    // --- Two accounts, each signed in with the fake, the project trusted in each, each with Main (its first) and Builder.
    const connect = async (name, email) => {
      fs.mkdirSync(accountsRoot, { recursive: true })
      fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email, orgId: 'org-1' }))
      const a = await inv('connections:add', 'claude-code', name)
      fs.writeFileSync(path.join(accountsRoot, a.id, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
      await inv('connections:signIn', a.id)
      check(`${name} signed in as ${email}`, !!(await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === a.id && c.accepted?.email === email) ?? null, HUNG_MS)))
      await inv('connections:setOn', a.id, true)
      const main = (await rows()).find((c) => c.account === a.id)
      await inv('connection:update', main.id, { name: 'Main' })
      const builder = await inv('connection:add', a.id, { name: 'Builder' })
      return { id: a.id, main: main.id, builder: builder.id }
    }
    const max1 = await connect('Max 1', 'one@example.com')
    const max2 = await connect('Max 2', 'two@example.com')
    await inv('agents:update', alpha, 'a-one', { connection: max1.builder })
    await inv('agents:update', alpha, 'a-two', { connection: max1.main })
    await inv('session:start', alpha, { agentId: 'a-one' })
    check('One runs on Max 1’s Builder', !!(await lib.until(async () => (await live('a-one'))?.status === 'ready' && (await live('a-one')).launchedConnection?.id === max1.id, HUNG_MS)))

    // --- The rule, set in Settings → Accounts & Connections: tick it, then 90% of its weekly limit, to Max 2.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    const block = page.locator(`.account-block[data-account="${max1.id}"]`)
    const rule = block.locator('[data-usage-move]')
    await rule.waitFor({ timeout: HUNG_MS })
    check('the rule is off by default', (await rule.getAttribute('data-usage-move')) === 'off')
    // Controlled by the saved rule: ticked once Hive has it (a click, then the wait below).
    await rule.locator('input[type="checkbox"]').click()
    check('ticked, it is on: 98% of the weekly limit, to Max 2', !!(await lib.until(async () => (await rule.getAttribute('data-usage-move')) === 'on', HUNG_MS)) && JSON.stringify((await inv('connections:list')).connections.find((c) => c.id === max1.id)?.usageMove) === JSON.stringify({ percent: 98, limit: 'weekly', to: max2.id }))
    const percent = rule.locator('.usage-move-percent')
    await percent.fill('90')
    await percent.press('Enter')
    check('…and the share changed to 90%', !!(await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === max1.id)?.usageMove?.percent === 90, HUNG_MS)))
    await page.mouse.move(5, 5)
    const box = await block.boundingBox()
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: path.join(lib.WORK, `usagemove-rule-${theme}.png`), ...(box ? { clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(1400, box.width + 16), height: box.height + 16 } } : {}) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.keyboard.press('Escape')

    const assistantFile = path.join(ws, '.combwork', 'assistant', '.combwork', 'project.json')
    const assistantConnection = () => (fs.existsSync(assistantFile) ? (JSON.parse(fs.readFileSync(assistantFile, 'utf8')).agents ?? []).map((a) => a.connection ?? null) : null)
    const assistantBefore = assistantConnection()
    // --- One reports Max 1 at 95% of its weekly limit: One switches to Max 2's Builder and resumes; Two moves at once.
    const since = (await live('a-one'))?.statusSince
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'a-one'), 'planusage 10 95', { submitted: async () => (await live('a-one'))?.statusSince !== since })
    check('Two (stopped) moves to Max 2’s Main', !!(await lib.until(async () => (await agentConnection('a-two')) === max2.main, HUNG_MS)), String(await agentConnection('a-two')))
    check('One (running) moves to Max 2’s Builder, the same name', !!(await lib.until(async () => (await agentConnection('a-one')) === max2.builder, HUNG_MS)), String(await agentConnection('a-one')))
    check('…and is resumed on Max 2 once its turn is over', !!(await lib.until(async () => (await live('a-one'))?.launchedConnection?.id === max2.id && (await live('a-one')).status === 'ready', HUNG_MS)), JSON.stringify((await live('a-one'))?.launchedConnection ?? null))
    const notices = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'notification' && /move from Max 1 to Max 2/.test(e.title ?? '')) // each tell() also logs an `entry` line (HI-2320, HI-2369)
    const told = await lib.until(async () => (notices().length ? notices() : null), HUNG_MS)
    check('a notice says who moved and why: One and Two', !!told && told.length === 1 && /2 agents move from Max 1 to Max 2/.test(told[0].title) && /One and Two/.test(told[0].body ?? ''), JSON.stringify(told))
    // The workspace's Assistant runs on Max 1 too (its CLI's first account here), and is never moved: its connection is
    // the user's (Settings → Assistant).
    check('the Hive Assistant stays where it was', JSON.stringify(assistantConnection()) === JSON.stringify(assistantBefore), JSON.stringify({ before: assistantBefore, now: assistantConnection() }))

    // --- The Assistant's view: GET /v1/connections gives the limits and the rule (cw_connection list's lines).
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const conns = await lib.until(async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/connections`, { headers: { Authorization: `Bearer ${token}`, 'X-Hive-Workspace': encodeURIComponent(ws) } }).then((x) => x.json()).catch(() => null)
      return r?.usage?.length ? r : null
    }, HUNG_MS)
    const mine = conns?.usage?.find((u) => u.account === 'Max 1')
    check('GET /v1/connections gives Max 1’s weekly 95% and its move', !!mine && mine.limits.some((l) => l.label === 'weekly' && l.usedPercent === 95) && mine.move?.to === 'Max 2' && mine.move.percent === 90, JSON.stringify(conns?.usage ?? null))

    // --- Nothing moves back: a low reading for Max 1 (as after a reset) leaves them on Max 2.
    await inv('agents:update', alpha, 'a-two', { connection: max1.main })
    await inv('session:stop', alpha, 'a-one')
    await lib.until(async () => !(await live('a-one')), HUNG_MS)
    check('Two, moved back by hand, stays on Max 1 for the period', (await agentConnection('a-two')) === max1.main)
    check('…and One stays on Max 2', (await agentConnection('a-one')) === max2.builder)
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
