// The Antigravity CLI as a provider (HI-2544), through Combwork with a stand-in agy (fake-agy/: no sign-in, no model):
// an agent on its PC-wide account launches in a private profile of its own (USERPROFILE; HOME left the user's), with
// auto-update off and an account variable of Combwork's own environment left out; a project that defines an MCP server
// the agent wasn't given (a sentinel, which marks a file when it is started) is refused before agy starts, as is one whose
// config can't be read, and the sentinel never starts (agy 1.5.0 can't be kept from starting it: HR1, fail closed); the
// conversation's id comes from the status line; two new conversations one after the other, then each resumed by its id;
// a conversation that isn't the agent's is never resumed. The fake proves the adapter's side only (HI-2548 runs the real
// CLI). Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'antigravity-profile')
const ws = path.join(lib.WORK, 'antigravity-ws')
const alpha = path.join(ws, 'alpha')
const agyLog = path.join(lib.WORK, 'antigravity-fake-agy.jsonl')
const marker = path.join(lib.WORK, 'antigravity-sentinel-started.txt')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const entries = (kind) => (fs.existsSync(agyLog) ? fs.readFileSync(agyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind) : [])

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const f of [agyLog, marker]) fs.rmSync(f, { force: true })
  lib.gitProject(alpha)
  // The project's own MCP server, which no agent was given: a sentinel that marks a file the moment it is started.
  const sentinel = path.join(lib.WORK, 'antigravity-sentinel.cjs')
  fs.writeFileSync(sentinel, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n'); setInterval(() => {}, 1000)\n`)
  fs.mkdirSync(path.join(alpha, '.agents'), { recursive: true })
  const projectMcp = path.join(alpha, '.agents', 'mcp_config.json')
  fs.writeFileSync(projectMcp, JSON.stringify({ mcpServers: { sentinel: { command: process.execPath, args: [sentinel] } } }))
  lib.enableProviders(userData, ['claude-code', 'antigravity'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.antigravity = { ...cfg.settings.providers.antigravity, executablePath: path.join(__dirname, 'fake-agy', 'agy.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // An account variable in Combwork's own environment, which Antigravity agents mustn't get.
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47901), FAKE_AGY_LOG: agyLog, GEMINI_API_KEY: 'not-for-agy' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const { until } = lib
  await page.getByText('alpha', { exact: true }).first().click()

  // --- Its PC-wide account, its own (never Copilot's).
  const accounts = (await inv('connections:list')).homes ?? []
  const own = accounts.find((a) => a.id === 'antigravity')
  check("Antigravity's PC-wide account is its own", !!own && own.provider === 'antigravity' && own.home === 'cli', JSON.stringify(accounts.map((a) => [a.id, a.provider, a.home])))

  // Its checks (HI-2698): agy's sign-in check ran in Combwork's check profile, under this test copy's data, never the user's.
  const checks = await until(async () => (entries('models').length ? entries('models') : null), HUNG_MS)
  check("agy's checks run in Combwork's check profile, never the user's own", !!checks && checks.every((m) => /antigravity[\\/]check$/i.test(m.env?.USERPROFILE ?? '') && m.env.USERPROFILE.toLowerCase().startsWith(userData.toLowerCase())), JSON.stringify(checks?.map((m) => m.env?.USERPROFILE)))

  const gem = await lib.addAgent(inv, alpha, { name: 'Gem', provider: 'antigravity' })
  check('an agent is added on Antigravity', gem?.provider === 'antigravity', JSON.stringify(gem))

  // --- A project server the agent wasn't given: refused before agy starts (nothing could keep agy from starting it).
  const refusedStart = () => inv('session:start', alpha, { agentId: gem.id }).then(() => null, (err) => String(err?.message ?? err))
  const why = await refusedStart()
  check("a project that defines an MCP server the agent wasn't given is refused, naming the server and its file", /MCP servers this agent wasn't given \(sentinel\)/.test(why ?? '') && (why ?? '').includes(projectMcp), why ?? 'started')
  check('…before agy starts', entries('session').length === 0 && !(await live(gem.id)), JSON.stringify(entries('session')))
  check('…and the sentinel never started', !fs.existsSync(marker))
  // --- A project config agy would read that Combwork can't: refused too (never read as none).
  fs.writeFileSync(projectMcp, '{ not json')
  const why2 = await refusedStart()
  check("a project config that can't be read is refused, naming the file", /couldn't read/.test(why2 ?? '') && (why2 ?? '').includes(projectMcp) && entries('session').length === 0, why2 ?? 'started')
  // Without the project's servers, it launches.
  fs.rmSync(projectMcp)

  // --- What the user sees, light and dark (kept with --keep-files): Provider Setup's tab, Settings → Accounts' PC-wide row,
  // its Settings page and its Advanced tab, all with the fake agy.
  const shots = async (name, target = page) => {
    while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
    await page.mouse.move(5, 5)
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await target.screenshot({ path: path.join(lib.WORK, `antigravity-${name}-${theme}.png`) })
    }
  }
  await page.evaluate(() => window.combwork.invoke('provider:refresh', 'antigravity'))
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').waitFor({ timeout: HUNG_MS })
  await page.keyboard.type('Provider Setup')
  await page.locator('.palette-item[data-command="help.agentSetup"]').waitFor({ timeout: HUNG_MS })
  await page.keyboard.press('Enter')
  const setup = page.locator('.dialog', { hasText: 'Provider Setup' })
  await setup.locator('.setup-tab', { hasText: 'Antigravity' }).click()
  check('Provider Setup has an Antigravity tab, the fake found and signed in', !!(await until(async () => /1\.5\.0/.test(await setup.innerText().catch(() => '')), HUNG_MS)), await setup.innerText().catch(() => ''))
  await shots('setup', setup)
  await page.keyboard.press('Escape')
  await setup.waitFor({ state: 'detached', timeout: HUNG_MS })
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
  await page.locator('.settings-nav .row[data-section="accounts"]').click()
  check("Settings → Accounts lists Antigravity's PC-wide sign-in", !!(await until(async () => /Antigravity/.test(await page.locator('.settings-content, .settings-page, main').first().innerText().catch(() => '')), HUNG_MS)))
  await shots('accounts')
  await page.locator('.settings-nav .row', { hasText: 'Antigravity' }).first().click()
  await until(async () => (await page.locator('.settings-nav .row.selected', { hasText: 'Antigravity' }).count()) > 0, HUNG_MS)
  await shots('settings')
  await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
  const agTab = page.locator('.advanced-tabs [role="tab"][data-tab="antigravity"]')
  await agTab.waitFor({ timeout: HUNG_MS })
  await agTab.click()
  // Its switches (Combwork's overrides) are on its connections, as every CLI's are; Advanced lists its CLI-facing values.
  check('Settings → Advanced has an Antigravity tab with its values', !!(await until(async () => (await page.locator('.advanced-row[data-advanced^="antigravity."]').evaluateAll((rs) => rs.filter((r) => r.checkVisibility()).length)) === 2, HUNG_MS)))
  await shots('advanced')
  await page.keyboard.press('Escape')
  await page.getByText('alpha', { exact: true }).first().click()

  // --- First conversation.
  const startNew = async (agentId = gem.id) => {
    const before = entries('session').length
    await inv('session:start', alpha, { agentId })
    await until(async () => entries('session').length > before, HUNG_MS)
    const conv = await until(async () => (await live(agentId))?.sessionId || null, HUNG_MS)
    // Recorded as the agent's conversation (its Sessions entry) before anything stops it, as a real turn gives it time to.
    await until(async () => (await inv('session:list', alpha)).some((s) => s.id === conv), HUNG_MS)
    return { conv, launch: entries('session').at(-1) }
  }
  const stop = async (agentId = gem.id) => {
    await inv('session:stop', alpha, agentId)
    return until(async () => !(await live(agentId)), HUNG_MS)
  }
  /** A turn in a conversation (its transcript, which a resume needs, in the agent's profile). */
  const say = async (agentId, profile, conv, text) => {
    const transcript = path.join(profile, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs', 'transcript.jsonl')
    await inv('pty:write', lib.ptyKey(alpha, agentId), text)
    await inv('pty:write', lib.ptyKey(alpha, agentId), '\r')
    return !!(await until(async () => fs.existsSync(transcript) && fs.readFileSync(transcript, 'utf8').includes(text), HUNG_MS))
  }
  const first = await startNew()
  check("the conversation's id comes from its status line", /^[0-9a-f-]{36}$/.test(first.conv ?? '') && first.conv === first.launch?.conversation, JSON.stringify({ conv: first.conv, launch: first.launch?.conversation }))
  const e = first.launch?.env ?? {}
  check('it runs in a private profile of its own (USERPROFILE), outside the workspace', !!e.USERPROFILE && !e.USERPROFILE.toLowerCase().startsWith(ws.toLowerCase()) && /antigravity[\\/]profiles[\\/]/i.test(e.USERPROFILE), JSON.stringify(e))
  check("…with HOME left the user's own (not the profile)", !!e.HOME && e.HOME !== e.USERPROFILE, JSON.stringify(e))
  check('…auto-update off', e.AGY_CLI_DISABLE_AUTO_UPDATE === 'true', JSON.stringify(e))
  check("…and Combwork's environment's GEMINI_API_KEY left out", e.GEMINI_API_KEY === undefined, JSON.stringify(e))
  const args = first.launch?.args ?? []
  check('it is given its settings for this launch only (--settings), the status line among them', args.includes('--settings') && /"statusLine"/.test(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8')), JSON.stringify(args))
  const profileMcp = JSON.parse(fs.readFileSync(path.join(e.USERPROFILE, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers
  check("its profile's MCP servers are Combwork's own", 'combwork' in profileMcp && !('sentinel' in profileMcp), JSON.stringify(Object.keys(profileMcp)))
  // A turn: written to its conversation.
  check('its turns are kept in its own conversation, in its profile', await say(gem.id, e.USERPROFILE, first.conv, 'hello antigravity'))
  check('it stops', !!(await stop()))

  // --- A second new conversation, then each resumed by its own id.
  const second = await startNew()
  check('a second new launch is a new conversation', !!second.conv && second.conv !== first.conv && second.launch?.resumed === false, JSON.stringify({ first: first.conv, second: second.conv }))
  check('…in the same private profile', second.launch?.env?.USERPROFILE === e.USERPROFILE)
  check('…with turns of its own', await say(gem.id, e.USERPROFILE, second.conv, 'second conversation'))
  await stop()
  for (const [name, c] of [['the first', first.conv], ['the second', second.conv]]) {
    const before = entries('session').length
    await inv('session:start', alpha, { agentId: gem.id, resumeId: c })
    await until(async () => entries('session').length > before, HUNG_MS)
    const l = entries('session').at(-1)
    check(`${name} conversation resumes by its id (--conversation)`, l?.resumed === true && l.conversation === c && l.args.includes('--conversation'), JSON.stringify(l))
    check(`…and the session is that conversation`, (await until(async () => ((await live(gem.id))?.sessionId === c ? c : null), HUNG_MS)) === c)
    await stop()
  }
  // --- Another agent's conversation (in its own profile): never resumed by this one, refused before agy starts.
  const other = await lib.addAgent(inv, alpha, { name: 'Ada', provider: 'antigravity' })
  const theirs = await startNew(other.id)
  check('another agent has a private profile of its own', !!theirs.launch?.env?.USERPROFILE && theirs.launch.env.USERPROFILE !== e.USERPROFILE, JSON.stringify(theirs.launch?.env))
  check('…and its own conversation', await say(other.id, theirs.launch.env.USERPROFILE, theirs.conv, 'hers'))
  await stop(other.id)
  const before = entries('session').length
  const refused = await inv('session:start', alpha, { agentId: gem.id, resumeId: theirs.conv }).then(() => null, (err) => String(err?.message ?? err))
  check("another agent's conversation is never resumed by this one", entries('session').length === before && !(await live(gem.id)) && /isn't in this agent's own conversations/.test(refused ?? ''), refused ?? 'started')
  check('the sentinel was never started, all along', !fs.existsSync(marker))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
