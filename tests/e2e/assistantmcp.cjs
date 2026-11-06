// The Combwork Assistant's MCP servers (HI-1472, HI-2059), in the window: a workspace from #1093's switches (notes and
// sandbox on in the workspace, extra off; demo has sandbox on and extra remembered while off; other has notes on) opens
// converted to added servers: demo has sandbox only, other notes, the Assistant none, and the dropped choice is said
// once. Settings → Assistant links to the Assistant's view, whose MCP Servers section adds one with the picker (search,
// what it runs, then Add) and removes it. The MCP view says where each is added; Add to… lists the Combwork Assistant after
// the projects. The Assistant's launch (the fake Claude Code's --mcp-config) has notes and not sandbox; demo's agent
// sandbox and not notes. GET /v1/mcp says where each is added for the workspace's token, and only its own project's for
// an agent's (demo's and other's, each its own); a project's status says `added`. Removing it tells the running
// Assistant to restart. Screenshots of the Assistant's view, the picker, the MCP view and Add to… in both themes
// (assistantmcp-*.png in the run's folder). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'assistantmcp-profile')
const ws = path.join(lib.WORK, 'assistantmcp-ws')
const proj = path.join(ws, 'demo')
const other = path.join(ws, 'other')
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
  for (const p of [proj, other]) fs.mkdirSync(path.join(p, '.combwork'), { recursive: true })
  // Three servers (they never run: the fake Claude Code only records its --mcp-config): notes and sandbox on in the
  // workspace, extra off. demo has sandbox on and extra kept while the workspace has it off; other has notes on.
  // workspace.json has no Assistant choices yet (a workspace from before).
  fs.mkdirSync(path.join(ws, '.combwork', 'mcp'), { recursive: true })
  for (const n of ['notes', 'sandbox', 'extra']) fs.writeFileSync(path.join(ws, '.combwork', 'mcp', `${n}.json`), JSON.stringify({ description: `The ${n} server`, command: 'node', args: [`${n}.js`], ...(n === 'notes' ? { tags: ['memory'] } : {}) }))
  fs.writeFileSync(path.join(ws, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['notes', 'sandbox'], model: 2 } }))
  fs.writeFileSync(path.join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, mcp: { disabled: [], enabled: ['extra', 'sandbox'] } }))
  fs.writeFileSync(path.join(other, '.combwork', 'project.json'), JSON.stringify({ version: 2, mcp: { disabled: [], enabled: ['notes'] } }))
  const env = lib.fakeClaude(userData, home, [proj, other, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT) } })
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
    const wsMcp = () => JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'workspace.json'), 'utf8')).mcp
    const projectMcp = (p) => JSON.parse(fs.readFileSync(path.join(p, '.combwork', 'project.json'), 'utf8')).mcp
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (route, token) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { headers: { Authorization: `Bearer ${token}` } })
      return { status: r.status, body: await r.json().catch(() => null) }
    }

    // --- The upgrade: what ran is added, nothing else; the dropped choice is said once.
    check('a workspace from before opens with no servers for the Assistant', !!(await lib.until(async () => JSON.stringify(wsMcp().assistant) === '[]' && wsMcp().assistantModel === 3, HUNG_MS)), JSON.stringify(wsMcp()))
    check("demo is converted: sandbox added, extra (off in the workspace) dropped", JSON.stringify(projectMcp(proj)) === JSON.stringify({ disabled: [], enabled: ['sandbox'], model: 3 }), JSON.stringify(projectMcp(proj)))
    check('other is converted: notes added', JSON.stringify(projectMcp(other).enabled) === '["notes"]' && projectMcp(other).model === 3, JSON.stringify(projectMcp(other)))
    check('the dropped choice is said once, then cleared', !!(await lib.until(async () => wsMcp().droppedNotice === undefined, HUNG_MS)), JSON.stringify(wsMcp()))

    // --- Settings → Assistant links to the Assistant's view.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: /^\s*Assistant\s*$/ }).click()
    const link = page.locator('[data-action="assistant-mcp-view"]')
    check("Settings → Assistant shows a link to the Assistant's view, not a list", !!(await lib.until(async () => (await link.count()) === 1, HUNG_MS)) && (await page.locator('.assistant-mcp').count()) === 0)
    await link.scrollIntoViewIfNeeded()
    await link.click()
    const section = page.locator('.sidebar .pane-body')
    const none = page.locator('[data-assistant-mcp-none]')
    check("…which shows the Assistant's view, its MCP Servers empty", !!(await lib.until(async () => (await page.locator('.assistant-summary').count()) === 1 && (await none.count()) === 1, HUNG_MS)))

    // --- + opens the picker: search, what it runs, Add.
    await page.locator('.sidebar').getByRole('button', { name: 'Add Server…', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Add a server for the Assistant' })
    const pickRow = (n) => picker.locator(`.mcp-picker-row[data-mcp="${n}"]`)
    check('the picker lists every server not added for it', !!(await lib.until(async () => (await picker.locator('.mcp-picker-row').count()) === 3, HUNG_MS)))
    const addButton = picker.getByRole('button', { name: 'Add', exact: true })
    check('…Add is greyed out until one is chosen', await addButton.isDisabled())
    await picker.locator('[data-mcp-search]').fill('memory')
    check('searching by a tag finds notes only', !!(await lib.until(async () => (await picker.locator('.mcp-picker-row').count()) === 1 && (await pickRow('notes').count()) === 1, HUNG_MS)))
    await pickRow('notes').click()
    check('…chosen, it shows what it runs', !!(await lib.until(async () => (await picker.locator('[data-mcp-runs="notes"]').innerText().catch(() => '')).includes('Runs: node notes.js'), HUNG_MS)) && (await addButton.isEnabled()))
    await shots('picker')
    await addButton.click()
    check('…added for the Assistant, in workspace.json, and no project', !!(await lib.until(async () => JSON.stringify(wsMcp().assistant) === '["notes"]', HUNG_MS)) && projectMcp(proj).enabled.join() === 'sandbox', JSON.stringify(wsMcp()))
    check("…and listed in the Assistant's view", !!(await lib.until(async () => (await section.locator('.row[data-mcp="notes"]').count()) === 1, HUNG_MS)))
    await shots('view')

    // --- The MCP view says where each is added; Add to… lists the Combwork Assistant last.
    await page.keyboard.press('Control+Shift+M')
    const row = (name) => page.locator('.pane-body .row', { has: page.locator('.label', { hasText: new RegExp(`^${name}\\s*$`) }) })
    const where = (name) => row(name).locator('.mcp-where').innerText().catch(() => '')
    check('notes: added in other and for the Combwork Assistant', !!(await lib.until(async () => (await where('notes')) === 'Added in other and for the Assistant', HUNG_MS)), await where('notes'))
    check('sandbox: added in demo', (await where('sandbox')) === 'Added in demo', await where('sandbox'))
    check('extra: not added anywhere, and no switch in the list', (await where('extra')) === 'Not added anywhere' && (await row('extra').getByRole('switch').count()) === 0, await where('extra'))
    await shots('mcp-view')
    await row('extra').click()
    await page.locator('[data-action="mcp-places"]').click()
    const places = page.getByRole('dialog', { name: 'Add extra to…' })
    const group = places.getByRole('group', { name: 'Projects to add it to' })
    const box = (name) => group.getByRole('checkbox', { name, exact: true })
    check("extra's Add to… lists the Combwork Assistant after the projects, unticked", !!(await lib.until(async () => (await box('Assistant').count()) === 1, HUNG_MS)) && !(await box('Assistant').isChecked()) && (await group.locator('label').last().getAttribute('data-assistant')) !== null)
    check('…and what it runs', (await places.innerText()).includes('Runs: node extra.js'))
    await shots('add-to')
    // All projects and No projects: the Assistant only ever by its own box.
    await places.getByRole('button', { name: 'All projects', exact: true }).click()
    check('…All projects ticks the projects, not the Assistant', (await box('demo').isChecked()) && (await box('other').isChecked()) && !(await box('Assistant').isChecked()))
    await box('Assistant').check()
    await places.getByRole('button', { name: 'No projects', exact: true }).click()
    check('…and No projects unticks them, leaving the Assistant as ticked', !(await box('demo').isChecked()) && (await box('Assistant').isChecked()))
    await places.getByRole('button', { name: 'Cancel' }).click()
    check('…cancelled, nothing changes', !!(await lib.until(async () => (await places.count()) === 0, HUNG_MS)) && JSON.stringify(wsMcp().assistant) === '["notes"]' && projectMcp(proj).enabled.join() === 'sandbox')

    // --- Each launch has only its own servers, the combwork server in both.
    const assistantHome = (await inv('workspace:refresh')).assistant.path
    const agent = await lib.addAgent(inv, proj, { name: 'Builder' })
    const otherAgent = await lib.addAgent(inv, other, { name: 'Writer' })
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    await inv('session:start', proj, { agentId: agent.id })
    await inv('session:start', other, { agentId: otherAgent.id })
    const launched = async (agentId) => {
      const file = path.join(home, 'fake-launches.jsonl')
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []
      for (const l of lines.map((x) => JSON.parse(x)).reverse()) {
        const f = l.opts?.['--mcp-config']
        const servers = f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers : null
        if (agentId === 'assistant' ? l.cwd?.toLowerCase() === ws.toLowerCase() : servers?.combwork?.env?.CW_AGENT_ID === agentId) return servers
      }
      return null
    }
    const a = await lib.until(() => launched('assistant'), 30000)
    const b = await lib.until(() => launched(agent.id), 30000)
    const c = await lib.until(() => launched(otherAgent.id), 30000)
    check("the Assistant's launch has notes and Combwork's server, not sandbox", !!a?.notes && !!a?.combwork && !a?.sandbox && !a?.extra, JSON.stringify(Object.keys(a ?? {})))
    check("demo's agent has sandbox and Combwork's server, not notes or extra", !!b?.sandbox && !!b?.combwork && !b?.notes && !b?.extra, JSON.stringify(Object.keys(b ?? {})))
    check("…without Combwork's own fields (its tags)", !('tags' in (c?.notes ?? { tags: 1 })) && !('description' in (c?.notes ?? {})), JSON.stringify(c?.notes))

    // --- The Agent API: where each is added for the workspace's token; only its own project's for an agent's.
    const of = (body, n) => body?.find((m) => m.name === n)
    const wide = await api('/v1/mcp', apiToken)
    check('GET /v1/mcp says where notes is added', wide.status === 200 && JSON.stringify(of(wide.body, 'notes')?.added) === JSON.stringify({ projects: ['other'], assistant: true }) && JSON.stringify(of(wide.body, 'extra')?.added) === JSON.stringify({ projects: [], assistant: false }) && !('globallyEnabled' in (of(wide.body, 'notes') ?? {})), JSON.stringify(wide))
    const tokenOf = (servers) => JSON.parse(fs.readFileSync(servers.combwork.env.CW_API_TOKEN_FILE, 'utf8')).token
    const demoView = await api('/v1/mcp', tokenOf(b))
    check("demo's agent hears only about demo: sandbox added, notes not, no projects or Assistant", demoView.status === 200 && of(demoView.body, 'sandbox')?.added === true && of(demoView.body, 'notes')?.added === false && demoView.body.every((m) => typeof m.added === 'boolean' && !('assistant' in m) && !('projects' in m)) && !JSON.stringify(demoView.body).includes('other'), JSON.stringify(demoView))
    const otherView = await api('/v1/mcp', tokenOf(c))
    check("other's agent hears only about other: notes added, sandbox not", otherView.status === 200 && of(otherView.body, 'notes')?.added === true && of(otherView.body, 'sandbox')?.added === false && !JSON.stringify(otherView.body).includes('demo'), JSON.stringify(otherView))
    const status = await api('/v1/projects/demo', tokenOf(b))
    check("demo's status says what is added there", JSON.stringify(status.body?.mcp) === JSON.stringify({ available: ['extra', 'notes', 'sandbox'], added: ['sandbox'], on: ['sandbox'] }) && JSON.stringify(status.body?.settings?.mcp) === '{"added":["sandbox"]}', JSON.stringify([status.body?.mcp, status.body?.settings?.mcp]))
    const workspace = await api('/v1/workspace', apiToken)
    check("GET /v1/workspace's config has no MCP lists", workspace.status === 200 && !('mcp' in (workspace.body?.config ?? { mcp: 1 })), JSON.stringify(workspace.body?.config).slice(0, 300))

    // --- Removed from it in its view (no question), the running Assistant is told to restart; the project agent isn't.
    const restartNeeded = async () => (await inv('workspace:refresh')).assistant?.agents?.[0]?.restartNeeded
    await lib.until(async () => (await inv('session:live')).some((x) => x.projectPath.toLowerCase() === assistantHome.toLowerCase()), HUNG_MS)
    check('the running Assistant needs no restart yet', (await restartNeeded()) === false)
    await page.locator('.activity-btn[aria-label="Assistant"]').click()
    const added = section.locator('.row[data-mcp="notes"]')
    await lib.until(async () => (await added.count()) === 1, HUNG_MS)
    await added.hover()
    await added.getByRole('button', { name: 'Remove notes from the Assistant', exact: true }).click()
    check('removing notes from it saves at once', !!(await lib.until(async () => JSON.stringify(wsMcp().assistant) === '[]', HUNG_MS)), JSON.stringify(wsMcp()))
    check("…and its view says none is added", !!(await lib.until(async () => (await none.count()) === 1, HUNG_MS)))
    check('…and the running Assistant needs a restart for it', !!(await lib.until(async () => (await restartNeeded()) === true, HUNG_MS)))
    check("…the project agent doesn't", (await inv('workspace:refresh')).projects.find((p) => p.name === 'demo').agents.find((x) => x.id === agent.id)?.restartNeeded === false)

    await inv('session:stop', proj, agent.id)
    await inv('session:stop', other, otherAgent.id)
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
