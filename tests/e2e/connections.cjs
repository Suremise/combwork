// Launching on a connection (HI-1755, S1; the test seam off so the
// real rule applies): with no connection on, an agent is refused and the project asks for one; two connections signed in
// (the fake Claude Code signs in, no browser); agents of one workspace on different connections at once (each launch
// logged in its own connection's folder); a second window's workspace on its own connection; a connection turned off
// moves its agent to the default at its next safe point (its turn over, its exit typed once, resumed in the same
// conversation); a signed-out connection is refused. The footer names the connection. Screenshots in both themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'connections-profile')
const home = path.join(lib.WORK, 'connections-claude-home')
const ws1 = path.join(lib.WORK, 'connections-ws1')
const ws2 = path.join(lib.WORK, 'connections-ws2')
const alpha = path.join(ws1, 'alpha')
const beta = path.join(ws2, 'beta')
const accountsRoot = path.join(userData, 'accounts')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
/** The agents launched on a connection: its folder's fake launch log. */
const launchedIn = (id) => lines(path.join(accountsRoot, id, 'fake-launches.jsonl'))

;(async () => {
  for (const d of [userData, ws1, ws2]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha, beta])
  for (const [dir, agents] of [
    [alpha, [{ id: 'a-one', name: 'One' }, { id: 'a-two', name: 'Two' }]],
    [beta, [{ id: 'b-one', name: 'Beta One' }]]
  ]) {
    lib.gitProject(dir)
    fs.mkdirSync(path.join(dir, '.combwork'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents }))
  }

  const { app, page } = await lib.launch({ userData, env: { ...env, HIVE_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const invOn = (p) => (ch, ...a) => p.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    const inv = invOn(page)
    const failure = (p) => p.then(() => null, (e) => String(e?.message ?? e))
    await lib.openWorkspace(inv, page, ws1)
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    const shots = async (name) => {
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.screenshot({ path: path.join(lib.WORK, `connections-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    // --- No connection on: refused, and the project asks for one. Nothing launched from the CLI's own home.
    const refused = await failure(inv('session:start', alpha, { agentId: 'a-one' }))
    check('with no connection on, an agent is refused, saying why', /No Claude Code account is on in this workspace/.test(refused ?? ''), refused ?? 'started')
    check('…nothing launched on the CLI home', lines(path.join(home, 'fake-launches.jsonl')).length === 0)
    await page.locator('.sidebar .tree-item', { hasText: 'alpha' }).first().click().catch(() => undefined)
    check('…and the project asks for a connection', !!(await lib.until(async () => (await page.locator('[data-connection-setup="project"]').count()) >= 1, HUNG_MS)))
    // On for everyone (HI-1774): the one-time notice, the Assistant's banner and Provider Setup's line, none of which falls
    // back to the CLI's own sign-in.
    check('the one-time notice says agents run on accounts (HI-2108), naming Claude Code', !!(await lib.until(async () => /Agents now run on accounts: add one for Claude Code/.test(await page.locator('[data-connections-intro]').innerText().catch(() => '')), HUNG_MS)))
    if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
    check("the Assistant asks for a connection too: it can't start without one", !!(await lib.until(async () => /so the Assistant can't start/.test(await page.locator('[data-connection-setup="assistant"]').innerText().catch(() => '')), HUNG_MS)))
    await shots('setup')
    // In narrow panes (HI-2535: 900 px with the sidebar and the Assistant open), each banner's button goes under its
    // message rather than squeezing it into a narrow column beside the button.
    await lib.fitWindow(app, page, { width: 900, height: 860 })
    const stacked = (where) =>
      page.locator(`[data-connection-setup="${where}"]`).first().evaluate((b) => {
        const text = b.querySelector('.wrap-banner-text')
        const btn = b.querySelector('.wrap-banner-actions .btn')
        if (!text || !btn) return false
        return btn.getBoundingClientRect().top >= text.getBoundingClientRect().bottom - 1
      })
    for (const where of ['project', 'assistant']) check(`at 900 px the ${where} banner's Add an Account goes under its message (HI-2535)`, !!(await lib.until(() => stacked(where), HUNG_MS)))
    await shots('setup-narrow')
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await page.keyboard.press('Control+Alt+I')
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').waitFor({ timeout: HUNG_MS })
    await page.keyboard.type('Provider Setup')
    await page.locator('.palette-item[data-command="help.agentSetup"]').waitFor({ timeout: HUNG_MS })
    await page.keyboard.press('Enter')
    const setupDialog = page.locator('.dialog', { hasText: 'Provider Setup' })
    check("Provider Setup's Claude Code tab: signed in per account (HI-2108), none on yet, no sign-in of its own", !!(await lib.until(async () => /signs in per account, and none is on in this workspace yet/.test(await setupDialog.locator('[data-connection-setup-line]').innerText().catch(() => '')), HUNG_MS)) && (await setupDialog.locator('button', { hasText: /^Sign in/ }).count()) === 0)
    await shots('agent-setup')
    await setupDialog.locator('[data-open-connections]').click()
    check('…Open Connections closes it and shows Settings → Connections', !!(await lib.until(async () => (await setupDialog.count()) === 0 && (await page.locator('.settings-nav .row.selected[data-section="accounts"]').count()) === 1, HUNG_MS)))
    // Copilot's PC-wide sign-in is its account (HI-2107, decision C), listed while Copilot is on.
    const copilotOn = (await inv('settings:get')).providers?.copilot?.enabled === true
    if (copilotOn) check("Settings → Accounts & Connections lists Copilot's sign-in as its account", !!(await lib.until(async () => (await page.locator('[data-account="copilot"][data-home]').count()) === 1, HUNG_MS)))
    await page.locator('.activity-btn[aria-label="Projects"]').click()

    // --- Two connections, each signed in with the fake (no browser), the workspace's folders trusted in each.
    const connect = async (name, email) => {
      fs.mkdirSync(accountsRoot, { recursive: true })
      fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email, orgId: 'org-1' }))
      const a = await inv('connections:add', 'claude-code', name)
      fs.writeFileSync(path.join(accountsRoot, a.id, 'fake-trusted.json'), JSON.stringify([alpha, beta].map((f) => f.toLowerCase())))
      await inv('connections:signIn', a.id)
      const ok = await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === a.id && c.accepted?.email === email) ?? null, HUNG_MS)
      check(`${name} signed in as ${email}`, !!ok)
      return a
    }
    const max1 = await connect('Max 1', 'one@example.com')
    check('…the one-time notice goes once a connection is added, for good', !!(await lib.until(async () => (await page.locator('[data-connections-intro]').count()) === 0, HUNG_MS)) && (await inv('connections:list')).intro === undefined)
    const max2 = await connect('Max 2', 'two@example.com')
    await inv('connections:setOn', max1.id, true)
    await inv('connections:setOn', max2.id, true)
    check('the first turned on is the default', (await inv('connections:list')).workspace['claude-code']?.default === max1.id)

    // --- Mixed agents in one workspace: One on the default (Max 1), Two on its own choice (Max 2), at once.
    await inv('agents:update', alpha, 'a-two', { connection: max2.id })
    await inv('session:start', alpha, { agentId: 'a-one' })
    await inv('session:start', alpha, { agentId: 'a-two' })
    check('One launches on the default connection, Max 1', !!(await lib.until(async () => launchedIn(max1.id).some((l) => l.env.CW_AGENT === 'One'), HUNG_MS)))
    check('…Two on its own, Max 2, at the same time', !!(await lib.until(async () => launchedIn(max2.id).some((l) => l.env.CW_AGENT === 'Two'), HUNG_MS)))
    check('…each with its connection’s folder as its home', launchedIn(max1.id).every((l) => l.env.CLAUDE_CONFIG_DIR === path.join(accountsRoot, max1.id)))
    // Its auto memory by its real path (HI-1899): the connection's projects folder is a junction to the CLI home's, and
    // the launch names exactly that project's memory folder there, allowing nothing more.
    const oneLaunch = launchedIn(max1.id).find((l) => l.env.CW_AGENT === 'One')
    const oneSettings = oneLaunch?.opts['--settings'] ? JSON.parse(fs.readFileSync(oneLaunch.opts['--settings'], 'utf8')) : {}
    const linkedProjects = fs.realpathSync(path.join(accountsRoot, max1.id, 'projects'))
    const memoryDir = path.join(linkedProjects, alpha.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
    check('…its projects folder a junction, its auto memory named by the real path', linkedProjects.toLowerCase() !== path.join(accountsRoot, max1.id, 'projects').toLowerCase() && oneSettings.autoMemoryDirectory === memoryDir && oneSettings.permissions === undefined, JSON.stringify({ got: oneSettings.autoMemoryDirectory, memoryDir, permissions: oneSettings.permissions }))
    // The Memory tab's auto memory opens and saves with connections on (HI-1999): it's listed from the CLI home's projects
    // folder, which the file guard accepts beside the connections' homes, and nothing else of that home.
    fs.mkdirSync(memoryDir, { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory\n')
    const auto = (await inv('memory:list', alpha)).find((s) => s.kind === 'auto-memory' && s.label === 'MEMORY.md')
    check('the Memory tab lists the project’s auto memory', !!auto, JSON.stringify(auto))
    const read = auto ? await failure(inv('file:read', auto.path).then((t) => { if (t !== '# Memory\n') throw new Error(`read ${JSON.stringify(t)}`) })) : 'not listed'
    check('…it opens', read === null, read)
    const saved = auto ? await failure(inv('file:write', auto.path, '# Memory\nsaved\n', '# Memory\n')) : 'not listed'
    check('…and saves', saved === null && fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8') === '# Memory\nsaved\n', saved)
    const settingsRead = await failure(inv('file:read', path.join(home, 'settings.json')))
    check('…while the CLI home’s other files stay refused', /only read and write files inside the workspace/.test(settingsRead ?? ''), settingsRead ?? 'read')
    check('…and its run says so', (await live('a-two'))?.launchedConnection?.id === max2.id && (await live('a-one'))?.launchedConnection?.id === max1.id)
    check('the footer names the connection', !!(await lib.until(async () => (await page.locator(`.foot-connection[data-connection="${max1.id}"]`).count()) >= 1, HUNG_MS)))
    await shots('running')

    // --- A second window: its workspace runs on its own connection.
    const next = app.waitForEvent('window')
    await inv('window:new')
    const p2 = await next
    await p2.waitForLoadState('domcontentloaded')
    await lib.appReady(p2)
    await lib.openWorkspace(invOn(p2), p2, ws2)
    const inv2 = invOn(p2)
    // A new workspace starts with the top of the order on (Max 1, HI-1875): this one runs on Max 2 alone.
    await inv2('connections:setOn', max2.id, true)
    await inv2('connections:setOn', max1.id, false)
    await inv2('session:start', beta, { agentId: 'b-one' })
    check('the second window’s agent runs on its own workspace’s connection, Max 2', !!(await lib.until(async () => launchedIn(max2.id).some((l) => l.env.CW_AGENT === 'Beta One'), HUNG_MS)))
    check('…while the first window’s agents keep theirs', (await live('a-one'))?.launchedConnection?.id === max1.id)
    await inv2('session:stop', beta, 'b-one')
    await p2.close()

    // --- Max 2 turned off here: Two moves to the default at its next safe point, in the same conversation.
    const before = await live('a-two')
    await inv('connections:setOn', max2.id, false)
    const result = await inv('session:switchConnection', alpha, 'a-two')
    check('Two’s switch is arranged for its next safe point', result === 'queued' || result === 'waiting', String(result))
    const moved = await lib.until(async () => {
      const st = await live('a-two')
      return st && st.runId !== before.runId && st.launchedConnection?.id === max1.id ? st : null
    }, HUNG_MS)
    check('…once its turn is over it carries on, on Max 1 (the default), noted', !!moved && moved.launchedConnection.note === 'offFallback', JSON.stringify(moved?.launchedConnection))
    check('…in the same conversation', !!moved && moved.sessionId === before.sessionId, `${moved?.sessionId} vs ${before.sessionId}`)
    check('…its exit typed once', lines(path.join(accountsRoot, max2.id, 'fake-exits.jsonl')).length === 1, String(lines(path.join(accountsRoot, max2.id, 'fake-exits.jsonl')).length))

    // --- The preference order (HI-1875): new launches use the first in the order that's on; running ones keep theirs.
    const order = async () => (await inv('connections:list')).connections.filter((c) => c.provider === 'claude-code').map((c) => c.id)
    const usedHere = async () => (await inv('connections:list')).workspace['claude-code']?.default
    const onHere = async () => (await inv('connections:list')).workspace['claude-code']?.on ?? []
    const oneLaunches = (id) => launchedIn(id).filter((l) => l.env.CW_AGENT === 'One').length
    const relaunchOne = async () => {
      await inv('session:stop', alpha, 'a-one')
      await lib.until(async () => !(await live('a-one')), HUNG_MS)
      await inv('session:start', alpha, { agentId: 'a-one' })
      return lib.until(async () => (await live('a-one'))?.launchedConnection?.id ?? null, HUNG_MS)
    }
    await inv('connections:setOn', max2.id, true)
    const runningOn = (await live('a-one'))?.launchedConnection?.id
    await inv('connections:move', max2.id, 0)
    check('Make Default moves Max 2 to the top of the order; it is used here now', JSON.stringify(await order()) === JSON.stringify([max2.id, max1.id]) && (await usedHere()) === max2.id)
    check('…One, running, keeps its connection (nothing restarts by itself)', runningOn === max1.id && (await live('a-one'))?.launchedConnection?.id === max1.id)
    const m2 = oneLaunches(max2.id)
    // Pinned to Max 1, the one it ran on, when its connection became its own (HI-2106): started again, it stays there.
    check('…started again, One, pinned to Max 1, stays on it (HI-2106)', (await relaunchOne()) === max1.id)
    // Its connection cleared: its CLI's first on here, the top of the order. Its run says so, and the fake logs the launch
    // in Max 2's folder (written as it starts: waited for).
    await inv('agents:update', alpha, 'a-one', { connection: null })
    check('…its connection cleared, One launches on the top of the order, Max 2', (await relaunchOne()) === max2.id && !!(await lib.until(async () => oneLaunches(max2.id) > m2, HUNG_MS)))
    await inv('connections:setOn', max2.id, false)
    check('the top turned off: One, running, keeps it', (await live('a-one'))?.launchedConnection?.id === max2.id)
    check('…started again, the next on in the order, Max 1', (await relaunchOne()) === max1.id)
    await inv('connections:setOn', max2.id, true)
    check('…the top back on: new launches use it again', (await relaunchOne()) === max2.id)
    // Make Default never turns one on: Max 1 off here, moved to the top, stays off, and Max 2 stays the one used.
    await inv('connections:setOn', max1.id, false)
    await inv('connections:move', max1.id, 0)
    check('Make Default on one that is off here leaves it off; the first on is used', JSON.stringify(await onHere()) === JSON.stringify([max2.id]) && (await usedHere()) === max2.id && (await order())[0] === max1.id)
    await inv('connections:setOn', max1.id, true)
    await inv('connections:setOn', max2.id, false)

    // --- A signed-out connection: refused, never another in its place.
    await inv('session:stop', alpha, 'a-one')
    await lib.until(async () => !(await live('a-one')), HUNG_MS)
    fs.rmSync(path.join(accountsRoot, max1.id, 'fake-account.json'))
    const out = await failure(inv('session:start', alpha, { agentId: 'a-one' }))
    check('a signed-out connection is refused, saying so', /Max 1 is signed out/.test(out ?? ''), out ?? 'started')
    await inv('session:stop', alpha, 'a-two')
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
