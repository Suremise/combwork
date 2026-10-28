// The Hive Assistant's MCP servers (HI-1472), in the window: a workspace from before (its servers on in the workspace,
// sandbox on in its project demo) opens with none for the Assistant. Settings → Assistant → MCP servers turns notes on
// for it after showing what it runs; a server off in the workspace can't be turned on there. The MCP view says where
// each runs, and its enable dialog lists the Hive Assistant after the projects. The Assistant's launch (the fake Claude
// Code's --mcp-config) has notes and not sandbox; the project agent's sandbox and not notes. GET /v1/mcp says it for
// the workspace's token and leaves it out for an agent's. Turning it off tells the running Assistant to restart.
// Screenshots of Settings → Assistant, its confirmation, the MCP view and the enable dialog in both themes
// (assistantmcp-*.png in the run's folder). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'assistantmcp-profile')
const ws = path.join(lib.WORK, 'assistantmcp-ws')
const proj = path.join(ws, 'demo')
const home = path.join(lib.WORK, 'assistantmcp-claude-home')
// Its own default, below the lanes' ports (47939 on, lanes.mjs) and no other suite's (HI-1921).
const PORT = Number(lib.port(47703))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(proj, '.hive'), { recursive: true })
  // Three servers (they never run: the fake Claude Code only records its --mcp-config): notes and sandbox on in the
  // workspace, extra off; sandbox on in demo. workspace.json has no Assistant choices yet (a workspace from before).
  fs.mkdirSync(path.join(ws, '.hive', 'mcp'), { recursive: true })
  for (const n of ['notes', 'sandbox', 'extra']) fs.writeFileSync(path.join(ws, '.hive', 'mcp', `${n}.json`), JSON.stringify({ description: `The ${n} server`, command: 'node', args: [`${n}.js`] }))
  fs.writeFileSync(path.join(ws, '.hive', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['notes', 'sandbox'], model: 2 } }))
  fs.writeFileSync(path.join(proj, '.hive', 'project.json'), JSON.stringify({ version: 2, mcp: { disabled: [], enabled: ['sandbox'] } }))
  const env = lib.fakeClaude(userData, home, [proj, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT) } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const shots = async (name) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(lib.WORK, `assistantmcp-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const wsMcp = () => JSON.parse(fs.readFileSync(path.join(ws, '.hive', 'workspace.json'), 'utf8')).mcp
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (route, token) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { headers: { Authorization: `Bearer ${token}` } })
      return { status: r.status, body: await r.json().catch(() => null) }
    }

    check('a workspace from before opens with no servers for the Assistant', !!(await lib.until(async () => JSON.stringify(wsMcp().assistant) === '[]', HUNG_MS)), JSON.stringify(wsMcp()))

    // --- Settings → Assistant → MCP servers.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: /^\s*Assistant\s*$/ }).click()
    const list = page.locator('.assistant-mcp')
    const item = (n) => list.locator(`.toggle-item[data-mcp="${n}"]`)
    check('Settings → Assistant lists the workspace servers, all off for it', !!(await lib.until(async () => (await list.locator('.toggle-item').count()) === 3, HUNG_MS)) && (await list.getByRole('switch', { checked: true }).count()) === 0)
    check('…extra, off in the workspace, says so and can\'t be turned on', (await item('extra').getAttribute('data-gated')) === 'true' && (await item('extra').innerText()).includes('Off in the workspace') && (await item('extra').getByRole('switch').isDisabled()))
    await item('notes').scrollIntoViewIfNeeded()
    await item('notes').getByRole('switch').click()
    const confirm = page.getByRole('dialog', { name: 'Turn on notes for the Assistant?' })
    check('turning notes on asks first, showing what it runs', !!(await lib.until(async () => (await confirm.count()) === 1, HUNG_MS)) && (await confirm.innerText()).includes('Runs: node notes.js'), JSON.stringify(await page.getByRole('dialog').allInnerTexts()))
    await shots('confirm')
    await confirm.getByRole('button', { name: 'Turn On', exact: true }).click()
    check('…and it is on for the Assistant, in workspace.json, and no project', !!(await lib.until(async () => JSON.stringify(wsMcp().assistant) === '["notes"]', HUNG_MS)) && JSON.parse(fs.readFileSync(path.join(proj, '.hive', 'project.json'), 'utf8')).mcp.enabled.join() === 'sandbox', JSON.stringify(wsMcp()))
    check('…its switch shows it', !!(await lib.until(async () => (await item('notes').getByRole('switch').getAttribute('aria-checked')) === 'true', HUNG_MS)))
    await shots('settings')

    // --- The MCP view says where each runs, and its enable dialog lists the Hive Assistant.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+M')
    const row = (name) => page.locator('.pane-body .row', { has: page.locator('.label', { hasText: new RegExp(`^${name}\\s*$`) }) })
    const where = (name) => row(name).locator('.mcp-where').innerText().catch(() => '')
    check('notes: on for the Hive Assistant only', !!(await lib.until(async () => (await where('notes')) === 'On for the Hive Assistant only', HUNG_MS)), await where('notes'))
    check('sandbox: on in demo', (await where('sandbox')) === 'On in demo', await where('sandbox'))
    await shots('view')
    await row('extra').getByRole('switch').click()
    const enable = page.getByRole('dialog', { name: 'Turn on extra?' })
    const group = enable.getByRole('group', { name: 'Projects to turn it on in' })
    check("extra's enable dialog lists the Hive Assistant after the projects, unticked", !!(await lib.until(async () => (await group.getByRole('checkbox', { name: 'Hive Assistant', exact: true }).count()) === 1, HUNG_MS)) && !(await group.getByRole('checkbox', { name: 'Hive Assistant', exact: true }).isChecked()) && (await group.locator('label').last().getAttribute('data-assistant')) !== null)
    await shots('enable')
    // All projects and No projects: the Assistant only ever by its own box.
    await enable.getByRole('button', { name: 'All projects', exact: true }).click()
    check('…All projects ticks the projects, not the Assistant', (await group.getByRole('checkbox', { name: 'demo', exact: true }).isChecked()) && !(await group.getByRole('checkbox', { name: 'Hive Assistant', exact: true }).isChecked()))
    await group.getByRole('checkbox', { name: 'Hive Assistant', exact: true }).check()
    await enable.getByRole('button', { name: 'No projects', exact: true }).click()
    check('…and No projects unticks them, leaving the Assistant as ticked', !(await group.getByRole('checkbox', { name: 'demo', exact: true }).isChecked()) && (await group.getByRole('checkbox', { name: 'Hive Assistant', exact: true }).isChecked()))
    await enable.getByRole('button', { name: 'Cancel' }).click()
    check('…cancelled, nothing changes', !!(await lib.until(async () => (await enable.count()) === 0, HUNG_MS)) && !wsMcp().enabled.includes('extra') && JSON.stringify(wsMcp().assistant) === '["notes"]')

    // --- Each launch has only its own servers, the hive server in both.
    const assistantHome = (await inv('workspace:refresh')).assistant.path
    const agent = await lib.addAgent(inv, proj, { name: 'Builder' })
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    await inv('session:start', proj, { agentId: agent.id })
    const launched = async (agentId) => {
      const file = path.join(home, 'fake-launches.jsonl')
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []
      for (const l of lines.map((x) => JSON.parse(x)).reverse()) {
        const f = l.opts?.['--mcp-config']
        const servers = f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers : null
        if (agentId === 'assistant' ? l.cwd?.toLowerCase() === ws.toLowerCase() : servers?.hive?.env?.HIVE_AGENT_ID === agentId) return servers
      }
      return null
    }
    const a = await lib.until(() => launched('assistant'), 30000)
    const b = await lib.until(() => launched(agent.id), 30000)
    check("the Assistant's launch has notes and the hive server, not sandbox", !!a?.notes && !!a?.hive && !a?.sandbox && !a?.extra, JSON.stringify(Object.keys(a ?? {})))
    check("the project agent's has sandbox and the hive server, not notes", !!b?.sandbox && !!b?.hive && !b?.notes, JSON.stringify(Object.keys(b ?? {})))

    // --- The Agent API: the workspace's token reads the Assistant's choices; an agent's call doesn't get them.
    const wide = await api('/v1/mcp', apiToken)
    const of = (body, n) => body?.find((m) => m.name === n)
    check('GET /v1/mcp says notes is on for the Assistant', wide.status === 200 && of(wide.body, 'notes')?.assistant === true && of(wide.body, 'sandbox')?.assistant === false, JSON.stringify(wide))
    const agentToken = JSON.parse(fs.readFileSync(b.hive.env.HIVE_API_TOKEN_FILE, 'utf8')).token
    const narrow = await api('/v1/mcp', agentToken)
    check("…and an agent's call lists the servers without it", narrow.status === 200 && narrow.body?.length === 3 && narrow.body.every((m) => !('assistant' in m)), JSON.stringify(narrow))

    // --- Turned off for it (no question), the running Assistant is told to restart; the project agent isn't.
    const restartNeeded = async () => (await inv('workspace:refresh')).assistant?.agents?.[0]?.restartNeeded
    await lib.until(async () => (await inv('session:live')).some((x) => x.projectPath.toLowerCase() === assistantHome.toLowerCase()), HUNG_MS)
    check('the running Assistant needs no restart yet', (await restartNeeded()) === false)
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: /^\s*Assistant\s*$/ }).click()
    await item('notes').scrollIntoViewIfNeeded()
    await item('notes').getByRole('switch').click()
    check('turning notes off for it saves at once', !!(await lib.until(async () => JSON.stringify(wsMcp().assistant) === '[]', HUNG_MS)), JSON.stringify(wsMcp()))
    check('…and the running Assistant needs a restart for it', !!(await lib.until(async () => (await restartNeeded()) === true, HUNG_MS)))
    check("…the project agent doesn't", (await inv('workspace:refresh')).projects.find((p) => p.name === 'demo').agents.find((x) => x.id === agent.id)?.restartNeeded === false)

    await inv('session:stop', proj, agent.id)
    await inv('session:stop', assistantHome, 'assistant')
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
