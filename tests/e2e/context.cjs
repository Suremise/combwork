// Use 200K context (instead of 1M): a connection's (HI-2108: no agent, Assistant, project or global choice of it), what
// a launch on it gets (CLAUDE_CODE_DISABLE_1M_CONTEXT, and the model without "[1m]"), and the Agent API refusing it on an
// agent. The model pickers have no 1M checkbox. Agents run the fake Claude Code (fake-claude/), which records each launch.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'context-profile')
const ws = path.join(lib.WORK, 'context-ws')
const claudeHome = path.join(lib.WORK, 'context-claude-home')
const proj = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const shot = (page, name) => page.screenshot({ path: path.join(lib.WORK, `context-${name}.png`) })

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(proj)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47899), CLAUDE_CONFIG_DIR: claudeHome })
  delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }
  const project = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === proj.toLowerCase())
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
  const launches = () => {
    try {
      return fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }

  // No global setting: each connection's (HI-1774).
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Claude Code' }).click()
  await lib.until(async () => (await page.getByText('CLI path', { exact: true }).count()) === 1, HUNG_MS)
  check('Settings → Claude Code has no such setting (each connection has its own)', (await page.locator('.setting', { hasText: 'Use 200K context (instead of 1M)' }).count()) === 0)
  check('no 1M checkbox in the model picker', (await page.getByText('1M context', { exact: true }).count()) === 0)
  await shot(page, '1-settings')
  await page.locator('.settings-nav .row', { hasText: 'Codex' }).click()
  await lib.sleep(400)
  check('Codex has no such setting', (await page.locator('.setting', { hasText: 'Use 200K context' }).count()) === 0)
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).first().click()
  await lib.until(async () => (await page.locator('.setting', { hasText: 'Highlight Compact over' }).count()) >= 1, HUNG_MS)
  check('Settings → Assistant has no such setting: its connection holds it (HI-2108)', (await page.locator('.setting', { hasText: 'Use 200K context' }).count()) === 0 && (await page.locator('.assistant-defaults').count()) === 0)

  // Add Agent (HI-2108): no context choice of its own; its connection holds it.
  await page.getByText('demo', { exact: true }).first().click()
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  const dialog = page.locator('.dialog', { hasText: 'Add an agent' })
  await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)
  check('Add Agent has no context choice (its connection holds it)', (await dialog.locator('.agent-form > label', { hasText: 'Use 200K context' }).count()) === 0)
  await dialog.locator('input.input').first().fill('Small')
  await shot(page, '2-add-agent')
  await dialog.locator('label', { hasText: 'Start a session now' }).locator('input').uncheck()
  await dialog.locator('.btn.primary', { hasText: 'Add Agent' }).click()
  await lib.until(async () => (await project()).agents.some((a) => a.name === 'Small'), 10000)
  let small = (await project()).agents.find((a) => a.name === 'Small')
  check('the agent has a connection and no context of its own', !!small?.connection && small.use200kContext === undefined, JSON.stringify(small))

  // A connection with 200K on its account (the connection dialog's save): a launch on it sets the variable and drops
  // "[1m]" (Claude Code rejects it with 1M off).
  const account = (await inv('connections:list')).connectionRows.find((c) => c.id === small.connection)?.account
  const big = await inv('connection:add', account, { name: 'Small context', model: 'opus[1m]', use200kContext: true })
  await inv('agents:update', proj, small.id, { connection: big.id })
  await inv('session:start', proj, { agentId: small.id })
  await until(async () => ['waiting', 'ready'].includes((await live(small.id))?.status), HUNG_MS)
  if ((await live(small.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(proj, small.id), '\r')
  await until(async () => (await live(small.id))?.status === 'ready', HUNG_MS)
  let last = launches().at(-1)
  check('launch sets CLAUDE_CODE_DISABLE_1M_CONTEXT=1', last?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1', JSON.stringify(last))
  check('launch runs the model without [1m]', last?.opts?.['--model'] === 'opus', last?.opts?.['--model'])

  // Turning it off on the connection asks the running agent for a restart; the next launch has 1M and keeps the model as chosen.
  await inv('connection:update', big.id, { use200kContext: null })
  const flagged = await until(async () => (await project()).agents.find((a) => a.id === small.id)?.restartNeeded, HUNG_MS)
  check('a change of its connection marks the running agent for restart', !!flagged)
  await inv('session:stop', proj, small.id)
  await until(async () => !(await live(small.id)), HUNG_MS)
  await inv('session:start', proj, { agentId: small.id })
  await until(async () => (await live(small.id))?.status === 'ready', HUNG_MS)
  last = launches().at(-1)
  check('off: no variable', last && last.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === undefined, JSON.stringify(last?.env))
  check('off: the model as chosen', last?.opts?.['--model'] === 'opus[1m]', last?.opts?.['--model'])
  await inv('session:stop', proj, small.id)
  await until(async () => !(await live(small.id)), HUNG_MS)
  await inv('connection:update', big.id, { use200kContext: true })

  // Project Settings has no Claude Code page any more (HI-2107); its agent list and Agent Settings sum up the connection.
  await lib.openProjectSettings(page)
  await lib.until(async () => (await page.locator('.settings-nav .row', { hasText: 'Agents' }).count()) >= 1, HUNG_MS)
  check('Project Settings has no Claude Code page, nor such a setting', (await page.locator('.settings-nav .row', { hasText: 'Claude Code' }).count()) === 0 && (await page.locator('.setting', { hasText: 'Use 200K context (instead of 1M)' }).count()) === 0)
  await shot(page, '3-project')
  await page.locator('.settings-nav .row', { hasText: 'Agents' }).first().click()
  const row = page.locator('.agent-list-row', { hasText: 'Small' })
  check("the agent list sums up its connection's values, 200K included", !!(await lib.until(async () => (await row.count()) === 1 && (await row.innerText()).includes('200K context'), HUNG_MS)), await row.innerText().catch(() => ''))
  await row.locator('[aria-label="Agent settings…"], [title="Agent settings…"]').first().click()
  const sd = page.locator('.dialog', { hasText: 'Small settings' })
  const summary = sd.locator('[data-connection-summary]')
  check("Agent Settings has no context choice, and sums up its connection's", !!(await lib.until(async () => (await summary.count()) === 1 && (await summary.innerText()).includes('200K context'), HUNG_MS)) && (await sd.locator('.agent-form > label', { hasText: 'Use 200K context' }).count()) === 0, await summary.innerText().catch(() => ''))
  await shot(page, '4-agent-settings')
  await sd.locator('.btn.subtle', { hasText: 'Cancel' }).click()

  // The Assistant: its connection's 200K reaches its launch.
  const home = (await inv('workspace:refresh')).assistant.path
  await inv('agents:update', home, 'assistant', { connection: big.id })
  const assistantLive = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase())
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => ['waiting', 'ready'].includes((await assistantLive())?.status), HUNG_MS)
  if ((await assistantLive())?.status === 'waiting') await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  await until(async () => (await assistantLive())?.status === 'ready', HUNG_MS)
  last = launches().at(-1)
  check("the Assistant's launch has 200K", last?.cwd?.toLowerCase() === ws.toLowerCase() && last?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1', JSON.stringify(last && { cwd: last.cwd, env: last.env }))

  // The Agent API (here with the Assistant's own token: only it may change agents) says which CLIs take context200k; agents don't.
  const { createHash } = require('crypto')
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`), 'utf8')).token
  const api = (method, url, body) =>
    fetch(`http://127.0.0.1:${lib.port(47899)}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  const providers = await api('GET', '/v1/providers')
  check('GET /v1/providers says which take context200k', providers.body?.find?.((p) => p.id === 'claude-code')?.context200k === true && providers.body.find((p) => p.id === 'codex')?.context200k === false, JSON.stringify(providers.body?.map?.((p) => [p.id, p.context200k])))
  // An agent's context200k is refused (HI-2108, decision D), naming the connections to use; nothing is added.
  const refused = await api('POST', '/v1/projects/demo/agents', { name: 'Api', context200k: 'on' })
  check('POST agents with context200k is refused, naming the connections to use', refused.status === 400 && /connection/.test(refused.body?.error ?? '') && (await project()).agents.every((a) => a.name !== 'Api'), JSON.stringify(refused))
  const listed = await api('GET', '/v1/connections')
  check('GET /v1/connections lists a connection with its context', listed.body?.connections?.some?.((c) => c.id === big.id && c.context200k === true), JSON.stringify(listed.body))

  await app.close()
  console.log(failed ? `${failed} failed` : 'All passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
