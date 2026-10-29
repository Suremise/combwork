// Maximum agents (HI-2001), on fake Claude Code with no agent started: Agents per project from before (advanced.json's
// 16, the workspace's own 5) becomes Hive's and the workspace's Maximum agents, and leaves advanced.json. A project on
// Solo (Maximum agents 1, one agent): the Agent API's add is refused (409), naming Maximum agents and where the user
// raises it; the user's own add goes past it. Hive's Team 6 + pool loaded by hand into it: the Load dialog says it is
// over, and with its workflow unticked offers to raise the maximum (ticked); loading opens Version Control → Workflow
// with Maximum agents at 8, unsaved until Save…; lowered again in the form, the note says the agents stay; Team's
// preview shows the Maximum agents it sets against the value now. Screenshots.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const { createHash } = require('crypto')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'maxagents-profile')
const ws = path.join(lib.WORK, 'maxagents-ws')
const claudeHome = path.join(lib.WORK, 'maxagents-claude-home')
const shots = path.join(lib.WORK, 'maxagents-shots')
const solo = path.join(ws, 'solo')
const assistantHome = path.join(ws, '.hive', 'assistant')
const PORT = Number(lib.port(47794))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn) => lib.until(fn, HUNG_MS, 150)

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [userData, claudeHome, shots, path.join(ws, '.hive'), path.join(solo, '.hive')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(solo, 'notes.md'), '# Notes\n')
  // Solo, as "How do you work?" saves it, with its one agent.
  const soloOptions = { review: 'none', dependenciesDone: true, maxAgents: 1 }
  fs.writeFileSync(path.join(solo, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [{ id: 'a-s1', name: 'SO-B1', workflowRole: 'builder', provider: 'claude-code' }], workflow: { platform: 'none', preset: 'solo', options: soloOptions } }))
  // Agents per project from before HI-2001: Settings → Advanced's (advanced.json) and this workspace's own.
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'hive.agents.perProject': 16 } }))
  fs.writeFileSync(path.join(ws, '.hive', 'workspace.json'), JSON.stringify({ advanced: { 'hive.agents.perProject': 5 } }))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws, solo, assistantHome].map((p) => p.toLowerCase())))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' }, viewport: { width: 1500, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const text = async (l) => ((await l.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const projectOf = () => JSON.parse(fs.readFileSync(path.join(solo, '.hive', 'project.json'), 'utf8'))
    const agentNames = () => projectOf().agents.map((a) => a.name)
    const shoot = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        await page.mouse.move(5, 5)
        await target().screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- Agents per project carried over: Hive's 16 and the workspace's own 5, each its level's Maximum agents.
    const levelMax = async (level, platform) => (await inv('workflow:levelForm', level, platform)).own.maxAgents
    check("Hive's Agents per project (16) is Maximum agents in Hive's workflow defaults, for None and Git", !!(await until(async () => (await levelMax('global', 'none')) === 16 && (await levelMax('global', 'git')) === 16)), JSON.stringify([await levelMax('global', 'none'), await levelMax('global', 'git')]))
    check("…and the workspace's own (5) in the workspace's", (await levelMax('workspace', 'none')) === 5 && (await levelMax('workspace', 'git')) === 5, JSON.stringify([await levelMax('workspace', 'none'), await levelMax('workspace', 'git')]))
    const advancedValues = () => JSON.parse(fs.readFileSync(path.join(userData, 'advanced.json'), 'utf8')).values ?? {}
    check('…and gone from advanced.json', !!(await until(() => !('hive.agents.perProject' in advancedValues()))), JSON.stringify(advancedValues()))

    // --- On Solo: the Assistant, through the Agent API, keeps to Maximum agents (1); the user goes past it.
    const live = async (project, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === project.toLowerCase() && s.agentId === agentId && s.status !== 'stopped') ?? null
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    const ready = await until(async () => {
      const st = await live(assistantHome, 'assistant')
      if (st?.status === 'waiting') await inv('pty:write', lib.ptyKey(assistantHome, 'assistant'), '\r')
      return st?.status === 'ready' || st?.status === 'finished'
    })
    check('the Assistant starts', !!ready)
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const refused = await api('POST', '/v1/projects/solo/agents', { name: 'SO-B2' })
    check("the Assistant's add on Solo is refused (409), naming Maximum agents and where the user raises it", refused.status === 409 && /Maximum agents to 1, the user's team size/.test(refused.body?.error) && /Version Control → Workflow/.test(refused.body?.error), JSON.stringify(refused))
    check('…nothing added', JSON.stringify(agentNames()) === '["SO-B1"]', JSON.stringify(agentNames()))
    await lib.addAgent(inv, solo, { name: 'SO-B2' })
    check("the user's own add goes past it", !!(await until(() => agentNames().length === 2)), JSON.stringify(agentNames()))

    // --- Hive's Team 6 + pool (8 agents) loaded by hand: over Maximum agents, offered to raise it.
    await page.locator('.project-row', { hasText: 'solo' }).first().click()
    await until(async () => (await page.locator('.project-header h1').innerText().catch(() => '')) === 'solo')
    await lib.addMenuRun(page, 'Templates')
    const item = page.locator('.menu .menu-item').filter({ has: page.getByText('Team 6 + pool', { exact: true }) }).first()
    await until(async () => (await item.count()) === 1)
    await item.click()
    const load = page.locator('.dialog', { hasText: 'Load "Team 6 + pool"?' })
    const apply = load.locator('[data-workflow-apply]')
    const raise = load.locator('[data-raise-max]')
    check('the Load dialog: its workflow ticked (its size, 8, as Maximum agents), so no separate offer', !!(await until(async () => (await apply.count()) === 1 && (await apply.isChecked()) && (await raise.count()) === 0)), await text(load))
    await apply.uncheck()
    check('its workflow unticked: it offers to raise Maximum agents from 1 to 8, ticked', !!(await until(async () => (await raise.count()) === 1 && (await raise.isChecked()))) && /raise Maximum agents from 1 to 8/.test(await text(load)), await text(load))
    await shoot('1-load', () => load)
    await load.getByRole('button', { name: 'Load template' }).click()
    const row = page.locator('.vc-view .workflow-option[data-option="maxAgents"]')
    const box = row.locator('input')
    check('loaded past it: 8 agents', !!(await until(() => agentNames().length === 8)), JSON.stringify(agentNames()))
    check('…and Version Control → Workflow opens with Maximum agents at 8', !!(await until(async () => (await box.count()) === 1 && (await box.inputValue()) === '8')), await text(page.locator('.vc-view')))
    check('…nothing saved yet', projectOf().workflow.options.maxAgents === 1, JSON.stringify(projectOf().workflow.options))
    await row.scrollIntoViewIfNeeded()
    await shoot('2-raised', () => row)
    await page.locator('.workflow-actions [data-action="save"]').click()
    const confirmSave = page.locator('.dialog', { hasText: 'Save' }).last()
    if (await until(async () => (await confirmSave.getByRole('button', { name: 'Save', exact: true }).count()) === 1)) await confirmSave.getByRole('button', { name: 'Save', exact: true }).click()
    check('Save…: Maximum agents 8, still Solo (no other option changed)', !!(await until(() => projectOf().workflow.options.maxAgents === 8)) && projectOf().workflow.preset === 'solo', JSON.stringify(projectOf().workflow))
    const again = await api('POST', '/v1/projects/solo/agents', { name: 'SO-X' })
    check("…and at 8 the Assistant's add is refused again", again.status === 409 && /Maximum agents to 8/.test(again.body?.error), JSON.stringify(again))

    // --- Lowered in the form, under the agents it has: they all stay, and the row says so. Once the save has settled
    // (the form read again: its box at 8, nothing to save), so the form's reload doesn't replace what is typed.
    await until(async () => (await box.inputValue()) === '8' && (await page.locator('.workflow-actions [data-action="save"]').isDisabled()))
    await box.fill('2')
    await box.press('Enter')
    const over = row.locator('[data-note="over-max"]')
    check('lowered to 2: the row says the 8 agents stay and the Assistant adds none', !!(await until(async () => /This project has 8 agents: none is removed, but the Assistant can’t add another until it has fewer than 2\./.test(await text(over)))), await text(row))
    await shoot('3-over', () => row)

    // --- A preset's preview shows the Maximum agents it sets, with the value now (HR3's round 1).
    await page.locator('.vc-view .workflow-choice[data-choice="team"]').click()
    const previewRow = page.locator('.vc-view .workflow-preview li[data-option="maxAgents"]')
    check("Team's preview lists Maximum agents: 12, a change from 2 now", !!(await until(async () => (await previewRow.count()) === 1 && /Maximum agents: 12/.test(await text(previewRow)) && /Now: 2/.test(await text(previewRow)) && /\bchanges\b/.test((await previewRow.getAttribute('class')) ?? ''))), await text(page.locator('.vc-view .workflow-preview')))
    await shoot('4-preview', () => page.locator('.vc-view .workflow-preview'))
  } catch (e) {
    check('the suite threw', false, e.stack)
  } finally {
    await inv('session:stop', assistantHome, 'assistant').catch(() => undefined)
    await app.close().catch(() => undefined)
  }
  if (failed) {
    console.log(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
})()
