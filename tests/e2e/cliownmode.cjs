// "The CLI's own setting" (#1284, #966 row 1), and the Assistant's other MCP servers' switch (row 7) gone, on a fake Claude
// Code session (fake-claude/), so nothing signs in or spends tokens.
// 1. A project's agents on the CLI's own setting: the stopped agent's badge says "CLI's own" and its menu marks the
//    choice; launched, the CLI gets no --permission-mode; its hooks report the mode it runs in, which Combwork records as
//    seen while the badge keeps saying "CLI's own"; a conversation of its own, stopped and resumed, resumes with no flag
//    and the same state; the running agent's menu says why nothing switches live, and a switch restarts it in the mode
//    chosen (then passed again).
// 2. The Advanced row for the Assistant's servers is gone (HI-1472: its own choices, the assistantmcp suite).
// Screenshots of the badge and the menus in both themes (cliownmode-*.png in the run's folder).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'cliownmode-profile')
const ws = path.join(lib.WORK, 'cliownmode-ws')
const claudeHome = path.join(lib.WORK, 'cliownmode-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.appearance = { ...cfg.settings.appearance, theme: 'dark' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    /** Both themes' screenshots of what is on screen now, each once the window shows that theme. */
    const shots = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes(theme), HUNG_MS)
        await page.screenshot({ path: path.join(lib.WORK, `cliownmode-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // ---- 1. A Claude Code agent on the CLI's own setting: its connection's mode (HI-2106: no project layer).
    await inv('project:updateConfig', alpha, { layout: 'single' })
    const def = await lib.addAgent(inv, alpha, { name: 'Tester', permissionMode: 'cli-own' })
    await inv('workspace:refresh')
    await page.getByText('alpha', { exact: true }).first().click()
    const badge = page.locator('.pane-footer-bar .mode-badge')
    check("the stopped agent's badge says CLI's own", !!(await lib.until(async () => (await badge.count()) === 1 && /CLI's own/.test(await badge.innerText()), HUNG_MS)), await badge.innerText().catch(() => 'no badge'))
    await badge.click()
    const items = page.locator('.menu .menu-item')
    // Its mode is its connection's (HI-2122): the menu lists its account's connections with their modes, its own ticked,
    // and edits that connection last.
    check("its menu lists its account's connections, its own with the CLI's own setting", !!(await lib.until(async () => (await items.allInnerTexts()).some((t) => /Test · cli-own[\s\S]*CLI's own/.test(t)), HUNG_MS)), JSON.stringify(await items.allInnerTexts()))
    check('…and edits its connection last', ((await items.allInnerTexts()).at(-1) ?? '').startsWith('Edit "Test · cli-own"…'), JSON.stringify(await items.allInnerTexts()))
    await shots('stopped-menu')
    // Its last item opens that connection's dialog, its mode the CLI's own.
    await items.last().click()
    const modeSelect = page.locator('.dialog select[data-mode]')
    check('Edit opens its connection\'s dialog, with its mode', !!(await lib.until(async () => (await modeSelect.count()) === 1 && (await modeSelect.inputValue()) === 'cli-own', HUNG_MS)), String(await modeSelect.inputValue().catch(() => 'no dialog')))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await modeSelect.count()) === 0, HUNG_MS)
    // Picking another connection moves the agent onto it; nothing is made for it.
    const connectionOf = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === alpha.toLowerCase()).agents.find((a) => a.id === def.id).connection
    const own = await connectionOf()
    const count = (await inv('connections:list')).connectionRows.length
    await badge.click()
    await items.filter({ hasText: 'Claude Code' }).first().click()
    const moved = await lib.until(async () => ((await connectionOf()) !== own ? await connectionOf() : null), HUNG_MS)
    check('picking another connection moves the agent onto it, making none', !!moved && (await inv('connections:list')).connectionRows.length === count && /Auto/.test(await badge.innerText()), JSON.stringify({ moved, badge: await badge.innerText() }))
    await inv('agents:update', alpha, def.id, { connection: own })
    await lib.until(async () => /CLI's own/.test(await badge.innerText()), HUNG_MS)

    const launches = () => {
      const f = path.join(claudeHome, 'fake-launches.jsonl')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === def.id)
    await inv('session:start', alpha, { agentId: def.id })
    check('the fake Claude Code is ready', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)), JSON.stringify(await live().then((l) => l && { status: l.status })))
    const first = launches().at(-1)
    check('launched with no --permission-mode', !!first && !('--permission-mode' in first.opts), JSON.stringify(first?.opts))
    // Its hooks name the mode it runs in (with no flag, the fake's default: Manual): seen, never shown as its mode.
    check("its hooks' mode is recorded as seen, and its mode stays the CLI's own", !!(await lib.until(async () => (await live())?.modeObserved === 'manual', HUNG_MS)) && (await live())?.permissionMode === 'cli-own', JSON.stringify(await live().then((l) => l && { mode: l.permissionMode, seen: l.modeObserved })))
    check("the running agent's badge says CLI's own", /CLI's own/.test(await badge.innerText()), await badge.innerText())
    const tip = await lib.hoverTip(page, badge, (t) => /the CLI's own screen shows the one it is in/.test(t), HUNG_MS)
    check("its tooltip says the CLI's screen shows the mode", /Permission mode of the running session: CLI's own\. Combwork passed no mode, so the CLI's own screen shows the one it is in\./.test(tip), tip)
    await page.mouse.move(5, 5)

    // A conversation of its own (a prompt taken), stopped and resumed: resumed on the CLI's own setting, with no flag again.
    const transcriptHas = (text) => {
      const dir = path.join(claudeHome, 'projects')
      return fs.existsSync(dir) && fs.readdirSync(dir).some((d) => fs.readdirSync(path.join(dir, d)).some((f) => f.endsWith('.jsonl') && fs.readFileSync(path.join(dir, d, f), 'utf8').includes(text)))
    }
    const key = lib.ptyKey(alpha, def.id)
    check('a prompt is taken (a conversation to resume)', (await lib.sendPrompt(inv, key, 'hello from cli-own', { submitted: async () => transcriptHas('hello from cli-own'), waitMs: lib.TURN_HUNG_MS })) > 0)
    check('…and its turn ends', !!(await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), lib.TURN_HUNG_MS)), (await live())?.status)
    const sid = (await live()).sessionId
    await inv('session:stop', alpha, def.id)
    await lib.until(async () => !(await live()), HUNG_MS)
    const beforeResume = launches().length
    await inv('session:start', alpha, { agentId: def.id, resumeId: sid })
    check('resumed and ready', !!(await lib.until(async () => launches().length > beforeResume && (await live())?.status === 'ready', HUNG_MS)), JSON.stringify(await live().then((l) => l && { status: l.status })))
    const resumed = launches().at(-1)
    check('…resuming its conversation, with no --permission-mode', resumed?.opts['--resume'] === sid && !('--permission-mode' in resumed.opts), JSON.stringify(resumed?.opts))
    check("…its mode still the CLI's own, the one its hooks report seen", !!(await lib.until(async () => (await live())?.modeObserved === 'manual', HUNG_MS)) && (await live())?.permissionMode === 'cli-own' && (await live())?.sessionId === sid, JSON.stringify(await live().then((l) => l && { mode: l.permissionMode, seen: l.modeObserved, same: l.sessionId === sid })))
    check("…and its badge says CLI's own", !!(await lib.until(async () => /CLI's own/.test(await badge.innerText()), HUNG_MS)), await badge.innerText())

    await badge.click()
    check("the running agent's menu says why no mode switches live", !!(await lib.until(async () => (await items.allInnerTexts()).some((t) => /Combwork can't switch this session's mode\s*It started in the CLI's own setting/.test(t)), HUNG_MS)), JSON.stringify(await items.allInnerTexts()))
    const modes = (await items.allInnerTexts()).filter((t) => /^(Manual|Accept edits|Plan|Auto)\b/.test(t))
    check('…and every mode there restarts the session', modes.length === 4 && modes.every((t) => /Restarts the session/.test(t)), JSON.stringify(modes))
    await shots('running-menu')
    const r = await inv('session:setMode', alpha, def.id, 'plan')
    check('a live switch asks for a restart instead', r && r.ok === false && r.restart === true, JSON.stringify(r))

    await items.filter({ hasText: /^Plan/ }).first().click()
    const dialog = page.locator('.dialog', { hasText: 'Restart in Plan?' })
    check('choosing Plan asks to restart in it', !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)))
    const before = launches().length
    await dialog.locator('button', { hasText: 'Restart' }).last().click()
    check('restarted in Plan, the flag passed again', !!(await lib.until(async () => launches().length > before && (await live())?.permissionMode === 'plan' && (await live())?.status === 'ready', HUNG_MS)) && launches().at(-1).opts['--permission-mode'] === 'plan', JSON.stringify({ opts: launches().at(-1)?.opts, mode: (await live())?.permissionMode }))
    check('…and the badge says Plan', !!(await lib.until(async () => (await badge.innerText()).startsWith('Plan'), HUNG_MS)), await badge.innerText())
    await inv('session:stop', alpha, def.id)
    await lib.until(async () => !(await live()), HUNG_MS)

    // ---- 2. The Assistant's servers are its own choices now (HI-1472, the assistantmcp suite): the old Advanced row is gone.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    await page.locator('.advanced-list').waitFor({ timeout: HUNG_MS })
    check("Advanced no longer lists the Assistant's servers' switch", (await page.locator('.advanced-row[data-advanced="hive.assistant.otherMcpServers"]').count()) === 0)
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
