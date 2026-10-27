// The agent rows and the template load dialog name connections (HI-1769, S2; behind Settings → Advanced → Connections
// (preview), the test seam off so the real rule applies): in Project Settings → Agents, an agent on the workspace's
// default, one on its own connection, and one whose connection was removed (shown as unusable, never as another); a
// running agent keeps the connection it runs on, marked ⟳ once the default changes, in the list and the Overview. A
// template saved with an agent on Max 2 names it beside its id; Max 2 removed, the load dialog says so on that agent with
// the workspace's default preselected (inheriting), never another by name, and the loaded agent follows the default.
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
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  // Three: a connection this machine doesn't have (removed since, or from another machine).
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }, { id: 'a-two', name: 'Two' }, { id: 'a-three', name: 'Three', connection: 'a-gone' }] }))

  const { app, page } = await lib.launch({ userData, env: { ...env, HIVE_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await inv('advanced:set', 'hive.accounts.preview', true)
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

    // --- One runs on the default (Max 1); then the default becomes Max 2: it keeps Max 1 until it restarts, marked ⟳.
    await inv('session:start', alpha, { agentId: 'a-one' })
    check('One runs on the default, Max 1', !!(await lib.until(async () => (await live('a-one'))?.launchedConnection?.id === max1.id, HUNG_MS)))
    await inv('connections:setDefault', max2.id)
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.openProjectSettings(page)
    const mark = (id) => page.locator(`.agent-list-row[data-agent="${id}"] .agent-connection`)
    const attrs = async (id) => mark(id).evaluate((el) => ({ id: el.dataset.connection, state: el.dataset.connectionState, other: el.hasAttribute('data-connection-other'), text: el.textContent.trim() })).catch(() => null)
    const one = await lib.until(async () => {
      const a = await attrs('a-one')
      return a?.id === max1.id && a.other ? a : null
    }, HUNG_MS)
    check("the Agents list: One shows the connection it runs on, Max 1, marked ⟳ (the default it follows is Max 2 now)", !!one && one.text === 'Max 1 ⟳' && one.state === 'inherited', JSON.stringify(await attrs('a-one')))
    const two = await attrs('a-two')
    check('…Two its own choice, Max 2', two?.id === max2.id && two.state === 'own' && !two.other && two.text === 'Max 2', JSON.stringify(two))
    const three = await attrs('a-three')
    check("…Three's removed connection shown as unusable, with no connection made up for it", three?.id === '' && three.state === 'deleted' && /Connection removed/.test(three.text), JSON.stringify(three))
    const tip = await lib.hoverTip(page, mark('a-one'), (t) => /Runs on Max 1 until it restarts/.test(t), HUNG_MS)
    check("…One's hover says it runs on Max 1 until it restarts, Max 2 chosen now", /Runs on Max 1 until it restarts\. Chosen now: Max 2/.test(tip), tip)
    await shots('agents')

    await page.locator('.tabs .tab', { hasText: 'Overview' }).first().click()
    const running = page.locator(`.running-row .running-connection[data-connection="${max1.id}"][data-connection-other]`)
    check('the Overview: One runs on Max 1, marked ⟳', !!(await lib.until(async () => (await running.count()) === 1, HUNG_MS)))
    await shots('overview')
    await inv('session:stop', alpha, 'a-one')
    await lib.until(async () => !(await live('a-one')), HUNG_MS)

    // --- A template: Two's connection named beside its id. Max 2 removed, then the template loaded into alpha again.
    await inv('connections:setDefault', max1.id)
    await inv('templates:save', alpha, 'workspace', 'Rows', false)
    const saved = JSON.parse(fs.readFileSync(path.join(ws, '.hive', 'templates', 'rows.json'), 'utf8'))
    check("the template keeps Two's connection by id, its name beside it for display", saved.agents.find((a) => a.name === 'Two')?.connection === max2.id && saved.agents.find((a) => a.name === 'Two')?.connectionName === 'Max 2', JSON.stringify(saved.agents))
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
    check("the load dialog: Two's Max 2 isn't here, said on its row", !!(await lib.until(async () => (await twoCell.getAttribute('data-connection-problem').catch(() => null)) === 'missing', HUNG_MS)) && /Max 2: no connection with that id here/.test(await twoCell.innerText()), await twoCell.innerText().catch(() => ''))
    const chosen = await twoCell.locator('select').evaluate((s) => ({ value: s.value, text: s.selectedOptions[0]?.textContent, options: [...s.options].map((o) => o.textContent) }))
    check("…the workspace's default preselected (it then follows the default), never another by name", chosen.value === '' && chosen.text === "Workspace's default (Max 1)" && !chosen.options.includes('Max 2'), JSON.stringify(chosen))
    check("…One, with none of its own, follows the default with no warning", (await cell('One').getAttribute('data-connection-problem')) === null && /Workspace's default \(Max 1\)/.test(await cell('One').innerText()), await cell('One').innerText())
    await shots('load')
    await dialog.getByRole('button', { name: 'Load template' }).click()
    const loaded = await lib.until(async () => {
      const agents = lib.projectConfig(userData, alpha).agents
      return agents.length === 3 && !agents.some((a) => ['a-one', 'a-two', 'a-three'].includes(a.id)) ? agents : null
    }, HUNG_MS)
    check('loaded: Two on the default, which it follows (no connection of its own)', !!loaded && !loaded.find((a) => a.name === 'Two')?.connection, JSON.stringify(loaded))
    check('…nothing launched on the CLI home', lines(path.join(home, 'fake-launches.jsonl')).length === 0)
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
