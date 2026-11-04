// The agent rows and the template load dialog name connections (HI-1769, S2; the test seam off so the real rule applies;
// HI-2106: agents always have their own): in Project Settings → Agents, an agent that had none and one whose connection
// was removed, each pinned to the one it runs on (the workspace's first on), and one on its own connection; reordering
// moves no agent, in the list and the Overview. A template is saved without connections, its load dialog asks about
// none, and the loaded agents go on the workspace's first on.
// Screenshots in both themes. The fake Claude Code signs in, no browser.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'connectionrows-profile')
const home = path.join(lib.WORK, 'connectionrows-claude-home')
const ws = path.join(lib.WORK, 'connectionrows-ws')
const alpha = path.join(ws, 'alpha')
const accountsRoot = path.join(userData, 'accounts')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha])
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  // Three: a connection this machine doesn't have (removed since, or from another machine).
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }, { id: 'a-two', name: 'Two' }, { id: 'a-three', name: 'Three', connection: 'a-gone' }] }))

  const { app, page } = await lib.launch({ userData, env: { ...env, HIVE_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    const shots = async (name) => {
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.screenshot({ path: path.join(lib.WORK, `connectionrows-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const connect = async (name, email) => {
      fs.mkdirSync(accountsRoot, { recursive: true })
      fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email, orgId: 'org-1' }))
      const a = await inv('connections:add', 'claude-code', name)
      fs.writeFileSync(path.join(accountsRoot, a.id, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
      await inv('connections:signIn', a.id)
      check(`${name} signed in`, !!(await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === a.id && c.accepted?.email === email) ?? null, HUNG_MS)))
      await inv('connections:setOn', a.id, true)
      return a
    }
    const max1 = await connect('Max 1', 'one@example.com')
    const max2 = await connect('Max 2', 'two@example.com')
    await inv('agents:update', alpha, 'a-two', { connection: max2.id })

    // --- One runs on the default (Max 1); then Max 2 is made Default (the top of the order, HI-1875): it keeps Max 1 until it restarts, marked ⟳.
    await inv('session:start', alpha, { agentId: 'a-one' })
    check('One runs on the default, Max 1', !!(await lib.until(async () => (await live('a-one'))?.launchedConnection?.id === max1.id, HUNG_MS)))
    await inv('connections:move', max2.id, 0)
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.openProjectSettings(page)
    // The list of agents is Project Settings → Agents' (HI-1765: it opens on General).
    await page.locator('.tab-body .settings-nav .row').filter({ has: page.locator('.label', { hasText: /^Agents$/ }) }).click()
    // A row names its connection (HI-2108: an account's base connection, its id), the account only while it runs on another.
    const rows = (await inv('connections:list')).connectionRows
    const c1 = rows.find((c) => c.account === max1.id)?.id
    const c2 = rows.find((c) => c.account === max2.id)?.id
    const mark = (id) => page.locator(`.agent-list-row[data-agent="${id}"] .agent-connection`)
    const attrs = async (id) => mark(id).evaluate((el) => ({ id: el.dataset.connection, state: el.dataset.connectionState, other: el.hasAttribute('data-connection-other'), text: el.textContent.trim() })).catch(() => null)
    const one = await lib.until(async () => {
      const a = await attrs('a-one')
      return a?.id === c1 ? a : null
    }, HUNG_MS)
    check('the Agents list: One, which had none, pinned to Max 1, the one it runs on (HI-2106): the new top of the order moves it not', !!one && one.text === 'Max 1' && one.state === 'own' && !one.other, JSON.stringify(await attrs('a-one')))
    const two = await attrs('a-two')
    check('…Two its own choice, Max 2', two?.id === c2 && two.state === 'own' && !two.other && two.text === 'Max 2', JSON.stringify(two))
    const three = await attrs('a-three')
    check("…Three, whose connection was removed, pinned to the workspace's first on, Max 1 (HI-2106, decision H)", three?.id === c1 && three.state === 'own', JSON.stringify(three))
    const tip = await lib.hoverTip(page, mark('a-one'), (t) => /Max 1/.test(t), HUNG_MS)
    check("…One's hover names Max 1", /Max 1/.test(tip) && !/Chosen now: Max 2/.test(tip), tip)
    await shots('agents')

    await page.locator('.tabs .tab', { hasText: 'Overview' }).first().click()
    const running = page.locator(`.running-row .running-connection[data-connection="${c1}"]:not([data-connection-other])`)
    check('the Overview: One runs on Max 1, its own, no ⟳', !!(await lib.until(async () => (await running.count()) === 1, HUNG_MS)))
    await shots('overview')

    // --- HI-2413: One moved to another connection on the account it runs on (Max 1, another model): Settings →
    // Accounts & Connections counts it, and its button switches it at its safe point, onto that connection.
    const before = await live('a-one')
    const sonnet = await inv('connection:add', max1.id, { name: 'Max 1 Sonnet', model: 'sonnet' })
    await inv('agents:update', alpha, 'a-one', { connection: sonnet.id })
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    const banner = page.locator('[data-switch-affected]')
    check('the banner counts One, on another connection of the same account', !!(await lib.until(async () => (await banner.innerText().catch(() => '')).trim().startsWith('1 running agent runs on another connection'), HUNG_MS)), await banner.innerText().catch(() => ''))
    await banner.getByRole('button', { name: 'Switch Them When Their Turn Is Over' }).click()
    const switched = await lib.until(async () => {
      const st = await live('a-one')
      return st && st.runId !== before.runId && st.launchedConnection?.connection?.id === sonnet.id ? st : null
    }, HUNG_MS)
    check('…its button switches One onto Max 1 Sonnet once its turn is over, in the same conversation', !!switched && switched.launchedConnection.id === max1.id && switched.sessionId === before.sessionId, JSON.stringify(switched?.launchedConnection ?? (await live('a-one'))?.launchedConnection))
    check('…and the banner goes', !!(await lib.until(async () => (await banner.count()) === 0, HUNG_MS)))
    const again = await inv('connections:switchAffected')
    check('…its own connection, now: nothing more to switch', !again.some((r) => r.agentId === 'a-one'), JSON.stringify(again))
    // Back to the project, its tabs shown, as connectiondefaults leaves Settings.
    await page.keyboard.press('Escape')
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().waitFor({ state: 'visible', timeout: HUNG_MS })
    await inv('session:stop', alpha, 'a-one')
    await lib.until(async () => !(await live('a-one')), HUNG_MS)

    // --- A template: Two's connection named beside its id. Max 2 removed, then the template loaded into alpha again.
    await inv('connections:move', max1.id, 0)
    await inv('templates:save', alpha, 'workspace', 'Rows', false)
    const saved = JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'templates', 'rows.json'), 'utf8'))
    check('the template is saved without connections (HI-2106)', saved.agents.every((a) => !('connection' in a) && !('connectionName' in a)), JSON.stringify(saved.agents))
    await inv('agents:update', alpha, 'a-two', { connection: null })
    await inv('connections:remove', max2.id)
    // + Add ▾ is on the Session tab's toolbar.
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    await lib.addMenuRun(page, 'Templates')
    const item = page.locator('.menu .menu-item').filter({ has: page.getByText('Rows', { exact: true }) }).first()
    if (!(await lib.until(async () => (await item.count()) === 1, HUNG_MS))) throw new Error('Templates ▸ has no Rows')
    await item.click()
    const dialog = page.locator('.dialog', { hasText: 'Load "Rows"?' })
    if (!(await lib.until(() => dialog.isVisible(), HUNG_MS))) throw new Error("the load dialog didn't show")
    const cell = (name) => dialog.locator(`.template-plan-table tbody tr[data-agent="${name}"] td.template-plan-connection`)
    const twoCell = cell('Two')
    check('the load dialog asks about no connection: none flagged', !!(await lib.until(async () => (await twoCell.count()) === 1, HUNG_MS)) && (await twoCell.getAttribute('data-connection-problem')) === null && (await cell('One').getAttribute('data-connection-problem')) === null, await twoCell.innerText().catch(() => ''))
    await shots('load')
    await dialog.getByRole('button', { name: 'Load template' }).click()
    const loaded = await lib.until(async () => {
      const agents = lib.projectConfig(userData, alpha).agents
      return agents.length === 3 && !agents.some((a) => ['a-one', 'a-two', 'a-three'].includes(a.id)) ? agents : null
    }, HUNG_MS)
    const accountOf = (id) => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).connections?.find((c) => c.id === id)?.account
    check("loaded: each on the workspace's first on, Max 1", !!loaded && loaded.every((a) => accountOf(a.connection) === max1.id), JSON.stringify(loaded))
    check('…nothing launched on the CLI home', lines(path.join(home, 'fake-launches.jsonl')).length === 0)
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
