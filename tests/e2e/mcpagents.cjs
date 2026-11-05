// Per-agent MCP server access (#537), in the window: two agents in one project with two workspace MCP servers on. The
// Agent Settings dialog gives Tester only one of them (MCP servers: Only these); Builder keeps all of the project's.
// Each agent's launch (the fake Claude Code's --mcp-config) has only its own servers, the hive server in both; the
// agent's tooltip, the project's MCP tab and the Agent API's project status say who has what; the API changes the choice
// and puts it back. Throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'mcpagents-profile')
const ws = path.join(lib.WORK, 'mcpagents-ws')
const proj = path.join(ws, 'demo')
const home = path.join(lib.WORK, 'mcpagents-claude-home')
const shots = path.join(lib.WORK, 'mcpagents-shots')
const PORT = Number(lib.port(47878))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(shots, { recursive: true })
  // Two servers, both on in the workspace (they never run: the fake Claude Code only records its --mcp-config).
  fs.mkdirSync(path.join(ws, '.combwork', 'mcp'), { recursive: true })
  for (const n of ['notes', 'sandbox']) fs.writeFileSync(path.join(ws, '.combwork', 'mcp', `${n}.json`), JSON.stringify({ description: `The ${n} server`, command: 'node', args: [`${n}.js`] }))
  fs.writeFileSync(path.join(ws, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['notes', 'sandbox'] } }))
  const env = lib.fakeClaude(userData, home, [proj, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT) } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const shot = (name) => page.screenshot({ path: path.join(shots, `mcpagents-${name}.png`) })
    // Reading with the Agent API's token; changing agents with the Assistant's own (only it may change them).
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const assistantToken = () => JSON.parse(fs.readFileSync(path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`), 'utf8')).token
    const api = async (method, route, body) => {
      const token = method === 'GET' ? apiToken : assistantToken()
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const agentsNow = async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'demo').agents

    const builder = await lib.addAgent(inv, proj, { name: 'Builder' })
    const tester = await lib.addAgent(inv, proj, { name: 'Tester' })
    check('a new agent gets all of the project\'s servers', !('mcpServers' in builder) && !('mcpServers' in tester))

    // --- Agent Settings: Only these, with notes unticked.
    await lib.agentMenu(page, 'Tester')
    // Its name on its pane's header: its hover is what its strip tab's was (#975).
    const tab = lib.paneHeader(page, 'Tester').locator('.agent-name')
    await page.locator('.menu-item', { hasText: 'Agent Settings…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Tester settings' })
    check('Agent Settings opens', !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)))
    const choice = dialog.getByRole('radiogroup', { name: 'MCP servers' })
    check("it says All of the project's", (await choice.getByRole('radio', { name: "All of the project's" }).getAttribute('aria-checked')) === 'true')
    await choice.getByRole('radio', { name: 'Only these' }).click()
    const list = dialog.getByRole('group', { name: 'Its MCP servers' })
    const box = (n) => list.locator('label', { hasText: new RegExp(`^\\s*${n}\\s*$`) }).locator('input')
    check('Only these lists the servers on, all ticked to start', !!(await lib.until(async () => (await box('notes').count()) === 1 && (await box('notes').isChecked()) && (await box('sandbox').isChecked()), HUNG_MS)))
    await box('notes').uncheck()
    await shot('1-dialog')
    await dialog.getByRole('button', { name: 'Save' }).click()
    const saved = await lib.until(async () => (await agentsNow()).find((a) => a.id === tester.id)?.mcpServers, HUNG_MS)
    check('the choice is saved on the agent', JSON.stringify(saved) === '["sandbox"]', JSON.stringify(saved))

    // --- The tooltip says it; the project's MCP tab says who gets each.
    const tip = await lib.hoverTip(page, tab, (t) => t.includes('MCP servers'))
    check("the agent's tooltip says its servers", tip.includes('MCP servers: only sandbox'), tip)
    await page.mouse.move(5, 5)
    await lib.openMoreTab(page, 'MCP')
    const row = (n) => page.locator('.toggle-item', { has: page.locator('.ti-name', { hasText: new RegExp(`^${n}\\b`) }) })
    check('the MCP tab says notes is given to Builder only', !!(await lib.until(async () => (await row('notes').innerText().catch(() => '')).includes('Given to Builder only'), HUNG_MS)), await row('notes').innerText().catch(() => ''))
    check('and sandbox to every agent', (await row('sandbox').innerText()).includes('Given to every agent'))
    await shot('2-mcp-tab')

    // --- The Agent API reports it.
    const status = (await api('GET', '/v1/projects/demo')).body
    const of = (name) => status?.agents?.find((a) => a.name === name)
    check('the API says what each agent gets', JSON.stringify([of('Builder')?.mcpServers, of('Builder')?.mcpChoice, of('Tester')?.mcpServers, of('Tester')?.mcpChoice]) === '[["notes","sandbox"],"all",["sandbox"],"only"]', JSON.stringify(status?.agents))

    // --- Each launch has only its own servers, the hive server in both.
    await inv('session:start', proj, { agentId: builder.id })
    await inv('session:start', proj, { agentId: tester.id })
    const launched = async (agentId) => {
      const file = path.join(home, 'fake-launches.jsonl')
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []
      for (const l of lines.map((x) => JSON.parse(x))) {
        const f = l.opts?.['--mcp-config']
        const servers = f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers : null
        if (servers?.combwork?.env?.CW_AGENT_ID === agentId) return servers
      }
      return null
    }
    const b = await lib.until(() => launched(builder.id), 30000)
    const t = await lib.until(() => launched(tester.id), 30000)
    check("Builder's launch has both servers", !!b?.notes && !!b?.sandbox && !!b?.combwork, JSON.stringify(Object.keys(b ?? {})))
    check("Tester's launch has only sandbox, and the hive server", !t?.notes && !!t?.sandbox && !!t?.combwork, JSON.stringify(Object.keys(t ?? {})))

    // --- The API changes the choice; a running agent is told to restart; ["*"] puts all back.
    // Changes through the Agent API are the Assistant's: started (in the workspace folder) for its token.
    const assistantHome = (await inv('workspace:refresh')).assistant.path
    const assistantLive = async () => (await inv('session:live')).find((x) => x.projectPath.toLowerCase() === assistantHome.toLowerCase())
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    check('the Assistant starts', !!(await lib.until(async () => ['waiting', 'ready'].includes((await assistantLive())?.status), HUNG_MS)))
    if ((await assistantLive())?.status === 'waiting') await inv('pty:write', lib.ptyKey(assistantHome, 'assistant'), '\r')
    await lib.until(async () => (await assistantLive())?.status === 'ready', HUNG_MS)
    const patched = await api('PATCH', `/v1/projects/demo/agents/Builder`, { mcpServers: ['notes'] })
    check('the API gives Builder only notes', patched.status === 200 && JSON.stringify(patched.body?.mcpServers) === '["notes"]', JSON.stringify(patched))
    check('and the running Builder needs a restart for it', !!(await lib.until(async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'demo').agents.find((a) => a.id === builder.id)?.restartNeeded, HUNG_MS)))
    const bad = await api('PATCH', `/v1/projects/demo/agents/Builder`, { mcpServers: ['hive'] })
    check('the hive server is not one to choose', bad.status === 400 && /always given/.test(bad.body?.error ?? ''), JSON.stringify(bad))
    const back = await api('PATCH', `/v1/projects/demo/agents/Builder`, { mcpServers: ['*'] })
    check('["*"] gives it all again', back.status === 200 && !('mcpServers' in (back.body ?? {})), JSON.stringify(back.body))

    await inv('session:stop', proj, builder.id)
    await inv('session:stop', proj, tester.id)
    await inv('session:stop', assistantHome, 'assistant')
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
