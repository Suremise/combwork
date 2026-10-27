// Use 200K context (instead of 1M): the agent's own choice and the Assistant's in the UI (Claude Code has no global or
// project choice since connections hold the defaults, HI-1774: a project's old value isn't read), and what a launch gets (CLAUDE_CODE_DISABLE_1M_CONTEXT, and the model without "[1m]"). The model
// pickers have no 1M checkbox. Agents run the fake Claude Code (fake-claude/), which records each launch.
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

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47899), CLAUDE_CONFIG_DIR: claudeHome })
  delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
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
  await lib.sleep(400)
  check('Settings → Assistant offers it for Claude Code', (await page.locator('.assistant-defaults label', { hasText: 'Use 200K context' }).count()) === 1)

  // Add Agent: the choice is there for Claude Code, and On is stored on the agent.
  await page.getByText('demo', { exact: true }).first().click()
  await lib.sleep(600)
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  await lib.sleep(800)
  const dialog = page.locator('.dialog', { hasText: 'Add an agent' })
  const ctxLabel = dialog.locator('.agent-form > label', { hasText: 'Use 200K context (instead of 1M)' })
  check('Add Agent has the choice for Claude Code', (await ctxLabel.count()) === 1)
  const ctxSelect = ctxLabel.locator('xpath=following-sibling::select[1]')
  check('…following its connection, none of the project', !/Project's/.test(await ctxSelect.locator('option').first().innerText()), await ctxSelect.locator('option').first().innerText())
  await ctxSelect.selectOption('on')
  await dialog.locator('input.input').first().fill('Small')
  await shot(page, '2-add-agent')
  await dialog.locator('label', { hasText: 'Start a session now' }).locator('input').uncheck()
  await dialog.locator('.btn.primary', { hasText: 'Add Agent' }).click()
  await lib.until(async () => (await project()).agents.some((a) => a.name === 'Small'), 10000)
  let small = (await project()).agents.find((a) => a.name === 'Small')
  check('agent stores use200kContext', small?.use200kContext === true, JSON.stringify(small))

  // A launch with it: the variable set, and "[1m]" dropped (Claude Code rejects it with 1M off).
  await inv('agents:update', proj, small.id, { model: 'opus[1m]' })
  await inv('session:start', proj, { agentId: small.id })
  await until(async () => ['waiting', 'ready'].includes((await live(small.id))?.status), HUNG_MS)
  if ((await live(small.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(proj, small.id), '\r')
  await until(async () => (await live(small.id))?.status === 'ready', HUNG_MS)
  let last = launches().at(-1)
  check('launch sets CLAUDE_CODE_DISABLE_1M_CONTEXT=1', last?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1', JSON.stringify(last))
  check('launch runs the model without [1m]', last?.opts?.['--model'] === 'opus', last?.opts?.['--model'])

  // Turning it off for the running agent asks for a restart; the next launch has 1M and keeps the model as chosen.
  await inv('agents:update', proj, small.id, { use200kContext: false })
  const flagged = await until(async () => (await project()).agents.find((a) => a.id === small.id)?.restartNeeded, HUNG_MS)
  check('a change marks the running agent for restart', !!flagged)
  await inv('session:stop', proj, small.id)
  await until(async () => !(await live(small.id)), HUNG_MS)
  await inv('session:start', proj, { agentId: small.id })
  await until(async () => (await live(small.id))?.status === 'ready', HUNG_MS)
  last = launches().at(-1)
  check('off: no variable', last && last.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === undefined, JSON.stringify(last?.env))
  check('off: the model as chosen', last?.opts?.['--model'] === 'opus[1m]', last?.opts?.['--model'])
  await inv('session:stop', proj, small.id)
  await until(async () => !(await live(small.id)), HUNG_MS)

  // null clears the agent's choice; a project's old On (from before connections) isn't read: its connection decides.
  await inv('agents:update', proj, small.id, { use200kContext: null })
  small = (await project()).agents.find((a) => a.id === small.id)
  check('null clears the choice', small.use200kContext === undefined, JSON.stringify(small))
  await inv('project:updateProvider', proj, 'claude-code', { use200kContext: 'on' })
  await inv('session:start', proj, { agentId: small.id })
  await until(async () => (await live(small.id))?.status === 'ready', HUNG_MS)
  check("a project's old On isn't read (HI-1774)", launches().at(-1)?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT === undefined, JSON.stringify(launches().at(-1)?.env))
  await inv('session:stop', proj, small.id)
  await until(async () => !(await live(small.id)), HUNG_MS)

  // Project Settings has no such row for Claude Code; Agent Settings shows the agent's own.
  await lib.openProjectSettings(page)
  await page.locator('.settings-nav .row', { hasText: 'Claude Code' }).click()
  await lib.until(async () => (await page.locator('.setting', { hasText: 'Extra arguments' }).count()) >= 1, HUNG_MS)
  check('Project Settings → Claude Code has no such setting', (await page.locator('.setting', { hasText: 'Use 200K context (instead of 1M)' }).count()) === 0)
  await shot(page, '3-project')
  await inv('agents:update', proj, small.id, { use200kContext: false })
  await page.locator('.settings-nav .row', { hasText: 'Agents' }).first().click()
  await lib.sleep(500)
  check('the agent list names the own choice', (await page.locator('.agent-list-row', { hasText: 'Small' }).innerText()).includes('200K context off'))
  await page.locator('.agent-list-row', { hasText: 'Small' }).locator('[aria-label="Agent settings…"], [title="Agent settings…"]').first().click()
  await lib.sleep(600)
  const sd = page.locator('.dialog', { hasText: 'Small settings' })
  const sdSelect = sd.locator('.agent-form > label', { hasText: 'Use 200K context' }).locator('xpath=following-sibling::select[1]')
  check('Agent Settings shows the agent’s Off', (await sdSelect.inputValue()) === 'off')
  check('…with its connection’s as the default, never the project’s', !/Project's/.test(await sdSelect.locator('option').first().innerText()), await sdSelect.locator('option').first().innerText())
  await shot(page, '4-agent-settings')
  await sdSelect.selectOption('')
  await sd.locator('.btn.primary', { hasText: 'Save' }).click()
  await lib.until(async () => (await project()).agents.find((a) => a.id === small.id)?.use200kContext === undefined, 10000)
  check('Save with the default clears it', (await project()).agents.find((a) => a.id === small.id)?.use200kContext === undefined)

  // The Assistant: Settings → Assistant's choice reaches its launch.
  await inv('settings:update', { assistant: { providers: { 'claude-code': { use200kContext: 'on' } } } })
  const home = (await inv('workspace:refresh')).assistant.path
  const assistantLive = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase())
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => ['waiting', 'ready'].includes((await assistantLive())?.status), HUNG_MS)
  if ((await assistantLive())?.status === 'waiting') await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  await until(async () => (await assistantLive())?.status === 'ready', HUNG_MS)
  last = launches().at(-1)
  check("the Assistant's launch has 200K", last?.cwd?.toLowerCase() === ws.toLowerCase() && last?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1', JSON.stringify(last && { cwd: last.cwd, env: last.env }))

  // The Agent API (here with the Assistant's own token: only it may change agents) takes context200k.
  const { createHash } = require('crypto')
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`), 'utf8')).token
  const api = (method, url, body) =>
    fetch(`http://127.0.0.1:${lib.port(47899)}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  const providers = await api('GET', '/v1/providers')
  check('GET /v1/providers says which take context200k', providers.body?.find?.((p) => p.id === 'claude-code')?.context200k === true && providers.body.find((p) => p.id === 'codex')?.context200k === false, JSON.stringify(providers.body?.map?.((p) => [p.id, p.context200k])))
  const added = await api('POST', '/v1/projects/demo/agents', { name: 'Api', context200k: 'on' })
  check('POST agents with context200k: on', added.body?.agent?.use200kContext === true, JSON.stringify(added))
  const patched = await api('PATCH', '/v1/projects/demo/agents/Api', { context200k: '' })
  check('PATCH with "" clears it', patched.status === 200 && patched.body?.id && patched.body.use200kContext === undefined && (await project()).agents.find((a) => a.name === 'Api')?.use200kContext === undefined, JSON.stringify(patched))
  const bad = await api('PATCH', '/v1/projects/demo/agents/Api', { context200k: 'maybe' })
  check('a bad value is refused', bad.status === 400, JSON.stringify(bad))

  await app.close()
  console.log(failed ? `${failed} failed` : 'All passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
