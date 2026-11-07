// A connection's launch settings and the Independent role (HI-2670, SPEC §11.2 "Launch settings"), on fake Claude Code agents
// with the test seam off: Settings → Accounts & Connections → a connection's ⋯ → Launch Settings…; "Launch as from a
// terminal" asks first while one of its agents holds a card in Doing, naming it, then saves, and the row is badged;
// its agents read as Independent in the Agent API (with `launch` in short), Agent Settings and Add Agent offer only
// Independent, and the Agent API refuses a lane with one; a launch on it has none of Combwork's server, guidance,
// pre-approval, isolation or API variables; the Agent API turns everything back on and the agents' own roles return.
// Screenshots of the dialog, the confirmation and the roles in both themes. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47862))
const userData = path.join(lib.WORK, 'launchsettings-profile')
const home = path.join(lib.WORK, 'launchsettings-claude-home')
const ws = path.join(lib.WORK, 'launchsettings-ws')
const shots = path.join(lib.WORK, 'launchsettings-shots')
const alpha = path.join(ws, 'alpha')
const accountsRoot = path.join(userData, 'accounts')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [userData, shots]) fs.mkdirSync(d, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  // The Agent API's connection changes are the Assistant's, with Change settings on (the user's token here).
  cfg.settings.assistant = { ...cfg.settings.assistant, changeSettings: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-hb1', name: 'HB1', workflowRole: 'builder' }, { id: 'a-hr1', name: 'HR1', workflowRole: 'reviewer' }] }))

  const { app, page } = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT), CW_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const agents = async () => Object.fromEntries((await api('GET', '/v1/projects/alpha')).body.agents.map((a) => [a.name, { role: a.workflowRole, launch: a.launch ?? null }]))
    const saved = () => JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8')).agents
    const shoot = async (name, target) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await target().screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- An account, signed in, with HB1 and HR1 on its first connection; HB1 holds a card in Doing.
    fs.mkdirSync(accountsRoot, { recursive: true })
    fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email: 'one@example.com', orgId: 'org-1' }))
    const max1 = await inv('connections:add', 'claude-code', 'Max 1')
    fs.writeFileSync(path.join(accountsRoot, max1.id, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
    await inv('connections:signIn', max1.id)
    check('Max 1 signed in', !!(await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === max1.id && c.accepted?.email) ?? null, HUNG_MS)))
    await inv('connections:setOn', max1.id, true)
    const conn = (await inv('connections:list')).connectionRows.find((c) => c.account === max1.id)
    for (const id of ['a-hb1', 'a-hr1']) await inv('agents:update', alpha, id, { connection: conn.id })
    const card = await inv('tasks:create', { title: 'Held card', project: 'alpha', agent: 'a-hb1', column: 'doing' })
    check('HB1 and HR1 are a builder and a reviewer, on Max 1', JSON.stringify(await agents()) === JSON.stringify({ HB1: { role: 'builder', launch: null }, HR1: { role: 'reviewer', launch: null } }), JSON.stringify(await agents()))

    // --- Launch Settings…, from the connection's ⋯: the preset turns everything off; saving asks first, naming HB1's card.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    const row = page.locator(`[data-connections-of="${max1.id}"] [data-connection="${conn.id}"]`)
    await row.waitFor({ timeout: HUNG_MS })
    await row.locator('[data-action="connection-menu"]').click()
    await page.locator('.menu .menu-item', { hasText: 'Launch Settings…' }).first().click()
    const dialog = page.locator(`[data-launch-settings="${conn.id}"]`)
    await dialog.waitFor({ timeout: HUNG_MS })
    const ticked = (id) => dialog.locator(`[data-launch-switch="${id}"] input`).isChecked()
    check('Launch Settings: everything on, the preset off', (await ticked('guidance')) && (await ticked('tools')) && (await ticked('typing')) && (await ticked('mcpIsolation')) && (await ticked('statusLine')) && !(await ticked('preset')))
    await dialog.locator('[data-launch-switch="preset"] input').check()
    check('…"Launch as from a terminal" turns every switch off', !!(await lib.until(async () => !(await ticked('guidance')) && !(await ticked('tools')) && !(await ticked('typing')) && !(await ticked('mcpIsolation')) && !(await ticked('statusLine')) && !(await ticked('promptSnapshotOff')), HUNG_MS)))
    await shoot('dialog', () => page.locator('.dialog', { has: dialog }))
    await page.locator('[data-save-launch]').click()
    const confirm = page.locator('.dialog', { hasText: 'Make 1 agent Independent?' })
    check('…saving asks first, naming HB1 and its card in Doing', !!(await lib.until(async () => (await confirm.count()) === 1 && /HB1 \(alpha\): .*Doing/.test(await confirm.innerText()), HUNG_MS)), await confirm.innerText().catch(() => ''))
    await shoot('confirm', () => confirm)
    await confirm.getByRole('button', { name: 'Make Independent' }).click()
    const plain = await lib.until(async () => (await inv('connections:list')).connectionRows.find((c) => c.id === conn.id && c.launch?.tools === false) ?? null, HUNG_MS)
    check('…confirmed, saved: every switch off', !!plain && plain.launch.guidance === false && plain.launch.typing === false && plain.launch.overrides?.statusLine === false && plain.launch.overrides?.mcpIsolation === false, JSON.stringify(plain?.launch))
    check('…the row says "As from a terminal"', !!(await lib.until(async () => /As from a terminal/.test(await row.locator(`[data-plain="${conn.id}"]`).innerText().catch(() => '')), HUNG_MS)))
    check('…the card stays where it was, HB1\'s', (await inv('tasks:list')).find((c) => c.number === card.number)?.column === 'doing')

    // --- Its agents are Independent now, their own roles kept.
    const now = await lib.until(async () => {
      const a = await agents()
      return a.HB1.role === 'independent' && a.HR1.role === 'independent' ? a : null
    }, HUNG_MS)
    check('the Agent API reads HB1 and HR1 as independent, launching plain', !!now && (now.HB1.launch ?? '').startsWith('plain'), JSON.stringify(now))
    check('…their own roles stay saved', saved().find((a) => a.id === 'a-hb1')?.workflowRole === 'builder' && saved().find((a) => a.id === 'a-hr1')?.workflowRole === 'reviewer', JSON.stringify(saved()))
    const lane = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'HB1', cards: [card.number] })
    check('…a lane with one is refused, saying it is Independent', lane.status === 400 && /HB1 is Independent/.test(JSON.stringify(lane.body)), JSON.stringify(lane))
    await page.keyboard.press('Escape')

    // --- Agent Settings: only Independent, the others greyed out saying why; Add Agent the same on that connection.
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.agentMenu(page, 'HB1')
    await page.locator('.menu-item', { hasText: 'Agent Settings…' }).click()
    const settings = page.getByRole('dialog', { name: 'HB1 settings' })
    await settings.waitFor({ timeout: HUNG_MS })
    const group = settings.getByRole('radiogroup', { name: 'Role in the workflow' })
    const chosen = (g) => g.locator('.choice.selected').getAttribute('data-workflow-role')
    check("Agent Settings: Independent chosen, the other roles greyed out with \"This connection launches without Combwork's tools\"", !!(await lib.until(async () => (await chosen(group)) === 'independent' && (await group.locator('[data-needs-tools]').count()) === 4 && (await group.locator('[data-workflow-role="builder"] input').isDisabled()), HUNG_MS)) && /This connection launches without Combwork's tools/.test(await group.innerText()))
    await shoot('agent-settings', () => settings)
    await settings.getByRole('button', { name: 'Save' }).click()
    check('…saving keeps its own role (builder) saved', !!(await lib.until(async () => (await settings.count()) === 0, HUNG_MS)) && saved().find((a) => a.id === 'a-hb1')?.workflowRole === 'builder', JSON.stringify(saved()))
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    const add = page.locator('.dialog', { hasText: 'Add an agent' })
    await add.waitFor({ timeout: HUNG_MS })
    const aGroup = add.getByRole('radiogroup', { name: 'Role in the workflow' })
    check('Add Agent on the plain connection offers only Independent', !!(await lib.until(async () => (await chosen(aGroup)) === 'independent' && (await aGroup.locator('[data-needs-tools]').count()) === 4, HUNG_MS)))
    await add.getByRole('button', { name: 'Cancel' }).click()

    // --- A launch on it: none of Combwork's server, guidance, pre-approval, isolation or API variables.
    const before = lines(path.join(accountsRoot, max1.id, 'fake-launches.jsonl')).length
    await inv('session:start', alpha, { agentId: 'a-hb1' })
    const started = await lib.until(() => lines(path.join(accountsRoot, max1.id, 'fake-launches.jsonl'))[before] ?? null, HUNG_MS)
    const opts = started?.opts ?? {}
    const mcpFile = opts['--mcp-config']
    const mcp = mcpFile && fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')) : null
    check('HB1 launches with no --strict-mcp-config, appended prompt or pre-approved tools', !!started && !('--strict-mcp-config' in opts) && !('--append-system-prompt-file' in opts) && !('--allowedTools' in opts), JSON.stringify(opts))
    check('…its MCP file has no server (no combwork)', !!mcp && Object.keys(mcp.mcpServers ?? {}).length === 0, JSON.stringify(mcp))
    check('…and no Agent API token or agent variables', !!started && !started.env.CW_API_TOKEN_FILE && !started.env.CW_AGENT && started.token === null, JSON.stringify(started?.env))
    check('…while Combwork still shows its status', !!(await lib.until(async () => ['ready', 'working', 'finished'].includes((await inv('session:live')).find((s) => s.agentId === 'a-hb1')?.status), HUNG_MS)))
    await inv('session:stop', alpha, 'a-hb1').catch(() => undefined)

    // --- The Assistant's cw_connection (Change settings on) turns everything on again: the agents' own roles are back.
    const assistantHome = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    check('the Assistant starts, with its token', !!(await lib.until(async () => fs.existsSync(asTokenFile), HUNG_MS)))
    const tool = (name, args) => {
      const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n', env: lib.childEnv({ CW_API_URL: `http://127.0.0.1:${PORT}`, CW_WORKSPACE: ws, CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, CW_API_TOKEN: '', CW_PROJECT: '' }), timeout: 60000 }).toString()
      const r = JSON.parse(out.split('\n')[0]).result
      return { text: r.content[0].text, isError: !!r.isError }
    }
    const back = tool('cw_connection', { action: 'update', connection: conn.id, launch: {} })
    check("the Assistant's cw_connection with launch {} turns everything on again", !back.isError && !(await inv('connections:list')).connectionRows.find((c) => c.id === conn.id)?.launch, JSON.stringify(back))
    const again = await lib.until(async () => {
      const a = await agents()
      return a.HB1.role === 'builder' && a.HR1.role === 'reviewer' ? a : null
    }, HUNG_MS)
    check('…HB1 is a builder and HR1 a reviewer again', !!again, JSON.stringify(await agents()))
    const refused = tool('cw_connection', { action: 'update', connection: conn.id, launch: { tools: false } })
    const fingerprint = /confirm: ([0-9a-f]+)/.exec(refused.text)?.[1]
    check('…turning its tools off again is refused without confirm, naming HB1 and a fingerprint', refused.isError && /HB1 \(/.test(refused.text) && !!fingerprint, JSON.stringify(refused))
    const confirmed = tool('cw_connection', { action: 'update', connection: conn.id, launch: { tools: false }, confirm: fingerprint })
    check('…and done with it', !confirmed.isError && (await inv('connections:list')).connectionRows.find((c) => c.id === conn.id)?.launch?.tools === false, JSON.stringify(confirmed))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
