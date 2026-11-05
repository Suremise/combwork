// Agents' roles in the workflow (#1430, SPEC §16.10.6), on fake Claude Code agents with the Assistant off: a project.json
// from before 1.0 (HB1 and HR1, no role saved) reads HR1 as a reviewer, in the Agent API and in Start Lane's lists,
// with nothing written; Add Agent offers Role in the workflow (Builder · Reviewer · Either, guessed from the name until
// chosen) and an agent added as a reviewer is offered as a lane's reviewer only; Agent Settings shows the guess, the
// free-text role as Note, and saving stores the role; an agent changed to Either is in both lists; the project hover's
// table shows each role; the Assistant's hive tools set a role (and add an agent with one) and refuse one that isn't a
// role; project agents have neither tool (only the Assistant changes agents).
// Screenshots of Add Agent, Agent Settings and the hover in both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47860))
const userData = path.join(lib.WORK, 'agentrole-profile')
const ws = path.join(lib.WORK, 'agentrole-ws')
const claudeHome = path.join(lib.WORK, 'agentrole-claude-home')
const shots = path.join(lib.WORK, 'agentrole-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.git(alpha, ['branch', '-M', 'main'])
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const saved = () => JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8')).agents
    const roles = async () => Object.fromEntries((await api('GET', '/v1/projects/alpha')).body.agents.map((a) => [a.name, a.workflowRole]))
    // Back to the project's Session tab from the board.
    const toSession = async () => {
      await page.locator('.activity-btn[aria-label="Projects"]').click()
      await page.getByText('alpha', { exact: true }).first().click()
      check('back on the Session tab', !!(await until(async () => await page.locator('.session-toolbar .add-menu').isVisible(), HUNG_MS)))
    }
    const shoot = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await target().screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- A project.json from before 1.0: HB1 and HR1, no role saved.
    await inv('project:updateConfig', alpha, { agents: [{ id: 'a-hb1', name: 'HB1', provider: 'claude-code' }, { id: 'a-hr1', name: 'HR1', provider: 'claude-code' }] })
    await inv('workspace:refresh')
    check('the Agent API reads HB1 as a builder and HR1 as a reviewer', JSON.stringify(await until(async () => {
      const r = await roles()
      return r.HB1 === 'builder' && r.HR1 === 'reviewer' ? r : null
    }, HUNG_MS)) === JSON.stringify({ HB1: 'builder', HR1: 'reviewer' }), JSON.stringify(await roles()))
    check('…and nothing is written', saved().every((a) => !('workflowRole' in a)), JSON.stringify(saved()))

    // --- Start Lane: builders and reviewers by role.
    await inv('tasks:create', { title: 'Role card', project: 'alpha' })
    await page.getByRole('button', { name: 'Task Board' }).click()
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
    await until(async () => (await column('Todo').locator('.task-card').count()) === 1, HUNG_MS)
    const item = (label) => page.locator('.menu[role="menu"] .menu-item', { hasText: label })
    const lane = page.locator('.dialog', { hasText: 'Start Lane' })
    const laneLists = async () => {
      await column('Todo').locator('.board-column-header').click({ button: 'right' })
      await until(async () => (await item('Start Lane with These Cards…').count()) === 1, HUNG_MS)
      await item('Start Lane with These Cards…').click()
      await until(async () => (await lane.count()) === 1 && (await lane.locator('#lane-start-builder option').count()) > 0, HUNG_MS)
      const names = (sel) => lane.locator(`${sel} option`).evaluateAll((os) => os.map((o) => o.textContent.replace(/ \(.*\)$/, '')))
      const out = { builders: await names('#lane-start-builder'), reviewers: (await names('#lane-start-reviewer')).slice(1), builder: await lane.locator('#lane-start-builder').inputValue(), reviewer: await lane.locator('#lane-start-reviewer').inputValue() }
      await lane.getByRole('button', { name: 'Cancel' }).click()
      await until(async () => (await lane.count()) === 0, HUNG_MS)
      return out
    }
    const l1 = await laneLists()
    check("Start Lane: HB1 is offered as the builder only, HR1 as the reviewer only, each chosen", JSON.stringify(l1) === JSON.stringify({ builders: ['HB1'], reviewers: ['HR1'], builder: 'a-hb1', reviewer: 'a-hr1' }), JSON.stringify(l1))

    // --- Add Agent: Role in the workflow, guessed from the name until chosen; added as a reviewer.
    await toSession()
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    const add = page.locator('.dialog', { hasText: 'Add an agent' })
    await until(async () => (await add.count()) === 1, HUNG_MS)
    const group = add.getByRole('radiogroup', { name: 'Role in the workflow' })
    const chosen = (g) => g.locator('.choice.selected').getAttribute('data-workflow-role')
    check('Add Agent offers Role in the workflow: Builder, Reviewer, Either, Generalist, each with a sentence', !!(await until(async () => (await group.locator('.choice').count()) === 4, HUNG_MS)) && /Builder\s*Works on cards[\s\S]*Reviewer\s*Reviews[\s\S]*Either\s*Builds or reviews[\s\S]*Generalist\s*Does whatever you ask in its pane/.test(await group.innerText()), await group.innerText().catch(() => ''))
    check('…a new agent ("Agent 3") reads as a builder', (await chosen(group)) === 'builder')
    await add.locator('.agent-form input.input').first().fill('HR2')
    check('…named HR2, the guess follows: reviewer', !!(await until(async () => (await chosen(group)) === 'reviewer', HUNG_MS)))
    await add.locator('.agent-form input.input').first().fill('ABCD-B1')
    check('…named ABCD-B1: builder', !!(await until(async () => (await chosen(group)) === 'builder', HUNG_MS)))
    await add.locator('.agent-form input.input').first().fill('ABCD-R1')
    check('…named ABCD-R1 (a four-letter key): reviewer', !!(await until(async () => (await chosen(group)) === 'reviewer', HUNG_MS)))
    await add.locator('.agent-form input.input').first().fill('Checker')
    check('…named Checker: builder again', !!(await until(async () => (await chosen(group)) === 'builder', HUNG_MS)))
    await group.locator('[data-workflow-role="reviewer"] input').check()
    check('…Reviewer chosen', !!(await until(async () => (await chosen(group)) === 'reviewer', HUNG_MS)))
    await add.locator('input[type="checkbox"]').first().uncheck()
    await shoot('add-agent', () => add)
    await add.getByRole('button', { name: 'Add Agent' }).click()
    check('Checker is added', !!(await until(async () => (await add.count()) === 0 && saved().some((a) => a.name === 'Checker'), HUNG_MS)))
    check('…with its role saved: reviewer', saved().find((a) => a.name === 'Checker')?.workflowRole === 'reviewer', JSON.stringify(saved()))
    await page.getByRole('button', { name: 'Task Board' }).click()
    const l2 = await laneLists()
    check("Start Lane: Checker is offered as a lane's reviewer only", JSON.stringify(l2.builders) === JSON.stringify(['HB1']) && JSON.stringify(l2.reviewers) === JSON.stringify(['HR1', 'Checker']), JSON.stringify(l2))

    // --- Agent Settings: HR1's guess shown, the free-text role as Note; Either saved.
    await toSession()
    await lib.agentMenu(page, 'HR1')
    await page.locator('.menu-item', { hasText: 'Agent Settings…' }).click()
    const settings = page.getByRole('dialog', { name: 'HR1 settings' })
    await until(async () => (await settings.count()) === 1, HUNG_MS)
    const sGroup = settings.getByRole('radiogroup', { name: 'Role in the workflow' })
    check("Agent Settings shows HR1's role as it reads: Reviewer", !!(await until(async () => (await chosen(sGroup)) === 'reviewer', HUNG_MS)))
    check('…and the free-text role as Note', (await settings.locator('label[for="agent-role"]').innerText()).trim() === 'Note')
    await sGroup.locator('[data-workflow-role="either"] input').check()
    await until(async () => (await chosen(sGroup)) === 'either', HUNG_MS)
    await shoot('agent-settings', () => settings)
    await settings.getByRole('button', { name: 'Save' }).click()
    check('Save stores HR1 as either', !!(await until(async () => (await settings.count()) === 0 && saved().find((a) => a.name === 'HR1')?.workflowRole === 'either', HUNG_MS)), JSON.stringify(saved()))
    check('…HB1, never saved, still has no role written', !('workflowRole' in saved().find((a) => a.name === 'HB1')))
    await page.getByRole('button', { name: 'Task Board' }).click()
    const l3 = await laneLists()
    check('Start Lane: an either-role agent is in both lists', l3.builders.includes('HR1') && l3.reviewers.includes('HR1') && !l3.builders.includes('Checker'), JSON.stringify(l3))

    // --- The project hover's table: each agent's role.
    await toSession()
    await page.mouse.move(700, 500)
    await until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
    await page.locator('.project-header .project-title .badge').first().hover()
    const tip = page.locator('.tip.agents-tip')
    await until(async () => (await tip.locator('table.agents-table tbody tr').count()) === 3, HUNG_MS)
    const table = await tip.locator('table.agents-table').evaluate((t) => ({ head: [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim()), rows: Object.fromEntries([...t.querySelectorAll('tbody tr')].map((r) => [r.dataset.agent, r.children[1]?.textContent.trim()])) }))
    check('the hover shows a Role column: HB1 Builder, HR1 Either, Checker Reviewer', table.head[1] === 'Role' && table.rows.HB1 === 'Builder' && table.rows.HR1 === 'Either' && table.rows.Checker === 'Reviewer', JSON.stringify(table))
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await until(async () => (await tip.count()) === 1, HUNG_MS)
      await tip.screenshot({ path: path.join(shots, `hover-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })

    // --- The hive tools: the Assistant (Control: projects) sets a role and adds an agent with one; a value that isn't a
    // role is refused; project agents have neither tool (assistantChange: only the Assistant changes agents).
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    check('the Assistant starts, with its token', !!(await until(async () => fs.existsSync(asTokenFile), HUNG_MS)))
    const mcp = (method, params, role) => {
      const extra = role === 'assistant' ? { CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, CW_API_TOKEN: '', CW_PROJECT: '' } : { CW_API_TOKEN_FILE: path.join(userData, 'agent-api.json'), CW_PROJECT: 'alpha', CW_AGENT_ID: 'a-hb1' }
      const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n', env: lib.childEnv({ CW_API_URL: `http://127.0.0.1:${PORT}`, CW_WORKSPACE: ws, ...extra }), timeout: 60000 }).toString()
      return JSON.parse(out.split('\n')[0]).result
    }
    const tool = (name, args, role = 'assistant') => {
      const r = mcp('tools/call', { name, arguments: args }, role)
      return { text: r.content[0].text, isError: !!r.isError }
    }
    const set = tool('cw_update_agent', { project: 'alpha', agent: 'HB1', workflowRole: 'either' })
    check("the Assistant's cw_update_agent sets HB1 to either", !set.isError && saved().find((a) => a.name === 'HB1')?.workflowRole === 'either', JSON.stringify(set))
    const bad = tool('cw_update_agent', { project: 'alpha', agent: 'HB1', workflowRole: 'boss' })
    check('…a value that is not a role is refused, nothing changed', bad.isError && /builder", "reviewer", "either" or "generalist/.test(bad.text) && saved().find((a) => a.name === 'HB1')?.workflowRole === 'either', JSON.stringify(bad))
    const added = tool('cw_add_agent', { project: 'alpha', name: 'Pal', workflowRole: 'either' })
    check('cw_add_agent with workflowRole: either', !added.isError && saved().find((a) => a.name === 'Pal')?.workflowRole === 'either', JSON.stringify(added))
    const listed = tool('cw_list_projects', {})
    check('cw_list_projects gives each agent its role', /HB1 \[claude-code, either\]/.test(listed.text) && /Checker \[claude-code, reviewer\]/.test(listed.text), listed.text)
    // --- A generalist (HI-686): added with the role, never offered by Start Lane, shown in the hover.
    const gen = tool('cw_add_agent', { project: 'alpha', name: 'Gen', workflowRole: 'generalist' })
    check('cw_add_agent with workflowRole: generalist', !gen.isError && saved().find((a) => a.name === 'Gen')?.workflowRole === 'generalist', JSON.stringify(gen))
    await page.getByRole('button', { name: 'Task Board' }).click()
    const l4 = await laneLists()
    check("Start Lane: a generalist is neither a lane's builder nor its reviewer", !l4.builders.includes('Gen') && !l4.reviewers.includes('Gen') && l4.builders.includes('HB1'), JSON.stringify(l4))
    await toSession()
    await page.mouse.move(700, 500)
    await until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
    await page.locator('.project-header .project-title .badge').first().hover()
    const genRow = await until(async () => (await tip.locator('table.agents-table tbody tr[data-agent="Gen"] td').nth(1).textContent().catch(() => null))?.trim() || null, HUNG_MS)
    check('…and the hover shows its role: Generalist', genRow === 'Generalist', String(genRow))
    await toSession()
    await lib.agentMenu(page, 'Gen')
    await page.locator('.menu-item', { hasText: 'Agent Settings…' }).click()
    const gSettings = page.getByRole('dialog', { name: 'Gen settings' })
    await until(async () => (await gSettings.count()) === 1, HUNG_MS)
    const gGroup = gSettings.getByRole('radiogroup', { name: 'Role in the workflow' })
    check('…its Agent Settings show Generalist chosen', !!(await until(async () => (await chosen(gGroup)) === 'generalist', HUNG_MS)))
    await shoot('agent-settings-generalist', () => gSettings)
    await gSettings.getByRole('button', { name: 'Cancel' }).click()
    const agentTools = mcp('tools/list', {}, 'agent').tools
    check('a project agent has neither cw_update_agent nor cw_add_agent', agentTools.length > 0 && !agentTools.some((t) => t.name === 'cw_update_agent' || t.name === 'cw_add_agent'), JSON.stringify(agentTools.map((t) => t.name)))
    // HI-2229: each role's most used tools are marked to be sent in full where a CLI defers tools; the rest aren't.
    const full = (list) => list.filter((t) => t._meta?.['anthropic/alwaysLoad'] === true).map((t) => t.name).sort().join(',')
    check("a project agent's cw_inbox, cw_list_tasks and cw_read_task are marked to load in full, no other", full(agentTools) === 'cw_inbox,cw_list_tasks,cw_read_task', full(agentTools))
    const assistantTools = mcp('tools/list', {}, 'assistant').tools
    check("…the Assistant's, and its cw_agent_activity and cw_project_status", full(assistantTools) === 'cw_agent_activity,cw_inbox,cw_list_tasks,cw_project_status,cw_read_task', full(assistantTools))
    const guessed = tool('cw_read_task', { key: 'AL-1' }, 'agent')
    check('a call with a guessed argument is refused as before, and told what the tool takes, naming no value', guessed.isError && /is not a card number/.test(guessed.text) && /cw_read_task takes number \(required\).*; missing: number; not: key\./.test(guessed.text) && !guessed.text.includes('AL-1'), guessed.text)
    const noProject = tool('cw_project_status', {})
    check("the Assistant's cw_project_status with no project says what to pass", noProject.isError && /project is required: a project's name, as cw_list_projects lists them/.test(noProject.text), noProject.text)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
