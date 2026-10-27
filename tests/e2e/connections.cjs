// Launching on a connection (HI-1755, S1; behind Settings → Advanced → Connections (preview), the test seam off so the
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
    fs.mkdirSync(path.join(dir, '.hive'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.hive', 'project.json'), JSON.stringify({ version: 2, agents }))
  }

  const { app, page } = await lib.launch({ userData, env: { ...env, HIVE_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const invOn = (p) => (ch, ...a) => p.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const inv = invOn(page)
    const failure = (p) => p.then(() => null, (e) => String(e?.message ?? e))
    await inv('advanced:set', 'hive.accounts.preview', true)
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
    check('with no connection on, an agent is refused, saying why', /No Claude Code connection is on in this workspace/.test(refused ?? ''), refused ?? 'started')
    check('…nothing launched on the CLI home', lines(path.join(home, 'fake-launches.jsonl')).length === 0)
    await page.locator('.sidebar .tree-item', { hasText: 'alpha' }).first().click().catch(() => undefined)
    check('…and the project asks for a connection', !!(await lib.until(async () => (await page.locator('[data-connection-setup]').count()) >= 1, HUNG_MS)))
    await shots('setup')

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
    const max2 = await connect('Max 2', 'two@example.com')
    await inv('connections:setOn', max1.id, true)
    await inv('connections:setOn', max2.id, true)
    check('the first turned on is the default', (await inv('connections:list')).workspace['claude-code']?.default === max1.id)

    // --- Mixed agents in one workspace: One on the default (Max 1), Two on its own choice (Max 2), at once.
    await inv('agents:update', alpha, 'a-two', { connection: max2.id })
    await inv('session:start', alpha, { agentId: 'a-one' })
    await inv('session:start', alpha, { agentId: 'a-two' })
    check('One launches on the default connection, Max 1', !!(await lib.until(async () => launchedIn(max1.id).some((l) => l.env.HIVE_AGENT === 'One'), HUNG_MS)))
    check('…Two on its own, Max 2, at the same time', !!(await lib.until(async () => launchedIn(max2.id).some((l) => l.env.HIVE_AGENT === 'Two'), HUNG_MS)))
    check('…each with its connection’s folder as its home', launchedIn(max1.id).every((l) => l.env.CLAUDE_CONFIG_DIR === path.join(accountsRoot, max1.id)))
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
    // A new workspace starts with the last used (Max 1): this one runs on Max 2 alone.
    await inv2('connections:setOn', max2.id, true)
    await inv2('connections:setOn', max1.id, false)
    await inv2('session:start', beta, { agentId: 'b-one' })
    check('the second window’s agent runs on its own workspace’s connection, Max 2', !!(await lib.until(async () => launchedIn(max2.id).some((l) => l.env.HIVE_AGENT === 'Beta One'), HUNG_MS)))
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
