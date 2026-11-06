// Plan usage per connection (HI-1756, Connections S5; the test seam
// off): two connections signed in through the fake Claude Code, an agent on each, each reporting its own limits
// ("planusage F W", as Claude Code's status line does). The status bar shows one item per connection, named, side by
// side, and no Claude Code-wide item; the Overview lists each connection with its login and its limits; the footer names
// each agent's connection, with who it is signed in as in its hover; the 95% warning is Max 2's alone, naming it. Screenshots of the status bar and the Overview, in both themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'connectionusage-profile')
const home = path.join(lib.WORK, 'connectionusage-claude-home')
const ws = path.join(lib.WORK, 'connectionusage-ws')
const alpha = path.join(ws, 'alpha')
const accountsRoot = path.join(userData, 'accounts')
// The Windows notifications the test copy would show (it is never focused, so a warning is one).
const notifyLog = path.join(lib.WORK, 'connectionusage-notify.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, notifyLog]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha])
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }, { id: 'a-two', name: 'Two' }] }))

  const { app, page, inv } = await lib.launch({ userData, env: { ...env, CW_TEST_CLI_HOME_CONNECTION: '0', CW_TEST_NOTIFY_LOG: notifyLog }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    const shots = async (name, clip) => {
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.screenshot({ path: path.join(lib.WORK, `connectionusage-${name}-${theme}.png`), ...(clip ? { clip } : {}) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    // --- Two connections, each signed in with the fake (no browser), the project trusted in each; One on Max 1 (the
    // default), Two on Max 2.
    const connect = async (name, email) => {
      fs.mkdirSync(accountsRoot, { recursive: true })
      fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email, orgId: 'org-1' }))
      const a = await inv('connections:add', 'claude-code', name)
      fs.writeFileSync(path.join(accountsRoot, a.id, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
      await inv('connections:signIn', a.id)
      const ok = await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === a.id && c.accepted?.email === email) ?? null, HUNG_MS)
      check(`${name} signed in as ${email}`, !!ok)
      await inv('connections:setOn', a.id, true)
      return a
    }
    const max1 = await connect('Max 1', 'one@example.com')
    const max2 = await connect('Max 2', 'two@example.com')
    await inv('agents:update', alpha, 'a-two', { connection: max2.id })
    for (const id of ['a-one', 'a-two']) await inv('session:start', alpha, { agentId: id })
    check('One runs on Max 1 and Two on Max 2', !!(await lib.until(async () => (await live('a-one'))?.status === 'ready' && (await live('a-two'))?.status === 'ready' && (await live('a-one')).launchedConnection?.id === max1.id && (await live('a-two')).launchedConnection?.id === max2.id, HUNG_MS)))

    // --- Each reports its own limits: Max 1 at 62% and 10%, Max 2 at 96% and 5%.
    const send = async (agentId, text) => {
      const since = (await live(agentId))?.statusSince
      const moved = async () => (await live(agentId))?.statusSince !== since
      const sent = await lib.sendPrompt(inv, lib.ptyKey(alpha, agentId), text, { submitted: moved })
      return sent > 0 && !!(await lib.until(async () => (await moved()) && (await live(agentId))?.status === 'finished', HUNG_MS))
    }
    check('One reports Max 1’s limits', await send('a-one', 'planusage 62 10'))
    check('Two reports Max 2’s limits', await send('a-two', 'planusage 96 5'))

    // --- The status bar: one item per connection, named, side by side; no Claude Code-wide one.
    const item = (id) => page.locator(`.statusbar .status-item[data-plan-connection="${id}"]`)
    const text = async (id) => ((await item(id).count()) === 1 ? (await item(id).innerText()).replace(/\s+/g, ' ') : '')
    check('the status bar shows Max 1’s own: 5h 62% · Week 10%', !!(await lib.until(async () => /Max 1.*5h 62%.*Week 10%/.test(await text(max1.id)), HUNG_MS)), await text(max1.id))
    check('…and Max 2’s beside it: 5h 96% · Week 5%, warned', !!(await lib.until(async () => /Max 2.*5h 96%.*Week 5%/.test(await text(max2.id)), HUNG_MS)) && /\bwarn\b/.test((await item(max2.id).getAttribute('class')) ?? ''), await text(max2.id))
    check('…and no Claude Code-wide item', (await page.locator('.statusbar .status-item[data-plan]:not([data-plan-connection])').count()) === 0)
    const kept = await inv('app:connectionPlanUsage')
    check('Combwork keeps each connection’s figures apart, none as Claude Code’s', kept[max1.id]?.limits[0]?.usedPercent === 62 && kept[max2.id]?.limits[0]?.usedPercent === 96 && !(await inv('app:planUsage'))['claude-code'], JSON.stringify({ kept, cli: (await inv('app:planUsage'))['claude-code'] ?? null }))
    await item(max1.id).hover()
    const tip = page.locator('.tip', { hasText: 'Max 1 (Claude Code' })
    check('the item’s hover names the connection and its CLI', !!(await lib.until(async () => (await tip.count()) >= 1, HUNG_MS)))
    const bar = await page.locator('.statusbar').boundingBox()
    if (bar) await shots('statusbar', { x: 0, y: Math.max(0, bar.y - 4), width: 1400, height: bar.height + 8 })

    // --- The 95% warning is Max 2's alone, naming it (a Windows notification, the test copy being in the background).
    const warned = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'notification' && /limit used/.test(e.title ?? ''))
    const logged = await lib.until(async () => (warned().length ? warned() : null), HUNG_MS)
    check('the 95% warning is Max 2’s alone, naming it', !!logged && logged.length === 1 && /96% of the 5-hour limit used on Max 2/.test(logged[0].title), JSON.stringify(warned()))

    // --- The Overview lists each connection with its login and limits.
    await item(max1.id).click()
    const row = (id) => page.locator(`.plan-connection-limits[data-plan-connection="${id}"]`)
    const rowText = async (id) => ((await row(id).count()) === 1 ? (await row(id).innerText()).replace(/\s+/g, ' ') : '')
    check('the Overview lists Max 1, signed in as one@example.com, 62% of its 5-hour limit', !!(await lib.until(async () => /Max 1 one@example\.com/.test(await rowText(max1.id)) && /62%/.test(await rowText(max1.id)), HUNG_MS)), await rowText(max1.id))
    check('…and Max 2, two@example.com, 96%', /Max 2 two@example\.com/.test(await rowText(max2.id)) && /96%/.test(await rowText(max2.id)), await rowText(max2.id))
    await shots('overview')

    // --- The footer names each agent's connection, who it is signed in as in its hover.
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    const foot =(id) => page.locator(`.foot-connection[data-connection="${id}"]`)
    check('the footers name Max 1 and Max 2', !!(await lib.until(async () => (await foot(max1.id).count()) >= 1 && (await foot(max2.id).count()) >= 1, HUNG_MS)) && /Max 1/.test(await foot(max1.id).first().innerText()) && /Max 2/.test(await foot(max2.id).first().innerText()))
    await foot(max2.id).first().hover()
    check('…its hover says who it is signed in as', !!(await lib.until(async () => (await page.locator('.tip', { hasText: 'Signed in as two@example.com.' }).count()) >= 1, HUNG_MS)))

    // --- Max 2 signed in again as another login, and that kept (HR2's round 1): its old figures and warning go, and a
    // session on the new login fills them from nothing.
    await inv('session:stop', alpha, 'a-two')
    await lib.until(async () => !(await live('a-two')), HUNG_MS)
    fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email: 'three@example.com', orgId: 'org-3' }))
    await inv('connections:signIn', max2.id)
    check('Max 2 is signed in as three@example.com now', !!(await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === max2.id && c.observed?.email === 'three@example.com') ?? null, HUNG_MS)))
    await inv('connections:keepLogin', max2.id)
    check('…its old login’s figures go: no Max 2 item, none kept', !!(await lib.until(async () => (await item(max2.id).count()) === 0 && !(await inv('app:connectionPlanUsage'))[max2.id], HUNG_MS)), JSON.stringify((await inv('app:connectionPlanUsage'))[max2.id] ?? null))
    await inv('session:start', alpha, { agentId: 'a-two' })
    check('Two starts again on Max 2', !!(await lib.until(async () => (await live('a-two'))?.status === 'ready' && (await live('a-two')).launchedConnection?.id === max2.id, HUNG_MS)))
    check('…and reports the new login’s limits', await send('a-two', 'planusage 1 1'))
    check('the status bar shows Max 2 at the new login’s 5h 1% · Week 1%, not warned', !!(await lib.until(async () => /Max 2.*5h 1%.*Week 1%/.test(await text(max2.id)), HUNG_MS)) && !/\b(warn|caution)\b/.test((await item(max2.id).getAttribute('class')) ?? ''), await text(max2.id))
    check('…and Max 1’s own figures are as they were', /Max 1.*5h 62%.*Week 10%/.test(await text(max1.id)), await text(max1.id))

    for (const id of ['a-one', 'a-two']) await inv('session:stop', alpha, id)
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
