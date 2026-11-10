// HI-2899: the Assistant on the fake Codex (no browser, no real sign-in; the test seam off so the real rule applies).
// A home the accounts migration pinned to Claude Code before HI-2899 (it never ran, nothing named its CLI) is unpinned as
// the workspace opens; with no account it asks for one in words for any coding agent; with only a Codex account on, no
// banner, and Start Assistant launches it on that Codex connection. Then the banner's buttons, clicked: its account signed
// out names it, and Open Accounts & Connections opens Settings there; its CLI chosen (Claude Code) with none of that CLI's
// but a Codex account on, Assistant Settings… opens its settings. Screenshots in both themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'assistantcodex-profile')
const claudeHome = path.join(lib.WORK, 'assistantcodex-claude-home')
const codexHome = path.join(lib.WORK, 'assistantcodex-codex-home')
const ws = path.join(lib.WORK, 'assistantcodex-ws')
const alpha = path.join(ws, 'alpha')
const assistantHome = path.join(ws, '.combwork', 'assistant')
const accountsRoot = path.join(userData, 'accounts')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const inHome = (l) => typeof l.cwd === 'string' && path.resolve(l.cwd).toLowerCase() === path.resolve(assistantHome).toLowerCase()
const homeAgent = () => JSON.parse(fs.readFileSync(path.join(assistantHome, '.combwork', 'project.json'), 'utf8')).agents?.[0] ?? null

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [userData, claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  // The Assistant's home as the accounts migration left a new workspace's before HI-2899: Claude Code pinned, with no
  // connection and its values waiting for an account; it never ran.
  fs.mkdirSync(path.join(assistantHome, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(assistantHome, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'assistant', name: 'Assistant', provider: 'claude-code' }], migrations: { accounts1: { at: '2026-11-09T10:00:00.000Z', assistant: {}, unplaced: { assistant: { permissionMode: 'default' } } } } }))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, CW_TEST_CLI_HOME_CONNECTION: '0', CW_TEST_TIPS: 'off' }
  const { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const shots = async (name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.locator('.assistant-panel').screenshot({ path: path.join(lib.WORK, `assistantcodex-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    // --- Unpinned as the workspace opened: it names no CLI, and with no account asks for one, any coding agent's.
    check('the pinned home, never run, names no CLI once the workspace has opened (unpinned)', !!(await lib.until(() => homeAgent() && !homeAgent().provider && !homeAgent().connection, HUNG_MS)), JSON.stringify(homeAgent()))
    if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
    const banner = page.locator('[data-connection-setup="assistant"]')
    check('…its banner asks for an account in words for any coding agent (never Claude Code)', !!(await lib.until(async () => (await banner.getAttribute('data-assistant-need').catch(() => null)) === 'noneAny', HUNG_MS)) && !/Claude Code/.test(await banner.innerText()), await banner.innerText().catch(() => ''))

    // --- Only a Codex account, signed in and on here: no banner, and Start Assistant launches it on that connection.
    fs.mkdirSync(accountsRoot, { recursive: true })
    fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email: 'work@example.com', plan: 'plus' }))
    const work = await inv('connections:add', 'codex', 'Work')
    await inv('connections:signIn', work.id)
    const view = async () => (await inv('connections:list')).connections.find((c) => c.id === work.id)
    check('Work (Codex) signed in', !!(await lib.until(async () => (await view())?.accepted?.email === 'work@example.com', HUNG_MS)))
    await inv('connections:setOn', work.id, true)
    check('…on here: the Assistant panel has no account banner', !!(await lib.until(async () => (await banner.count()) === 0, HUNG_MS)), await banner.innerText().catch(() => ''))
    // Its footer names Codex's model choice, not Claude Code's (Automatic's pick).
    check("…its footer shows Codex's model, never Claude Code's", !!(await lib.until(async () => !/Opus|Sonnet|Haiku/.test(await page.locator('.assistant-footer').innerText().catch(() => 'Opus')), HUNG_MS)), await page.locator('.assistant-footer').innerText().catch(() => ''))
    await shots('codex-on')
    await page.locator('.assistant-panel .assistant-idle .act-start').click()
    const launched = await lib.until(() => lines(path.join(accountsRoot, work.id, 'fake-launches.jsonl')).find(inHome) ?? null, HUNG_MS)
    let notes = []
    if (!launched) {
      await page.locator('.activity-btn.unread').click().catch(() => undefined)
      notes = await page.locator('.notif-panel .notif-item').allInnerTexts().catch(() => [])
      await page.screenshot({ path: path.join(lib.WORK, 'assistantcodex-after-start.png') })
    }
    const why = launched ? '' : JSON.stringify({ notes, toasts: await page.locator('.toast').allInnerTexts().catch(() => []), log: lib.combworkLogLines(userData).filter((l) => /assistant|refus|start|codex|connection/i.test(l)).slice(-25) })
    check('Start Assistant launches it on the fake Codex, in the Work connection’s folder', !!launched && launched.home === path.join(accountsRoot, work.id), JSON.stringify(launched) + why)
    const live = await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === 'assistant' && s.status !== 'stopped') ?? null, HUNG_MS)
    check('…running as Codex', live?.provider === 'codex', JSON.stringify(live && { provider: live.provider, launchedConnection: live.launchedConnection }))
    check('…and nothing launched on Claude Code', !lines(path.join(claudeHome, 'fake-launches.jsonl')).some(inHome))
    await inv('session:stop', assistantHome, 'assistant')
    await lib.until(async () => !(await inv('session:live')).some((s) => s.agentId === 'assistant' && s.status !== 'stopped'), HUNG_MS)

    // --- Its account signed out: named, and Open Accounts & Connections opens Settings there.
    fs.rmSync(path.join(accountsRoot, work.id, 'fake-account.json'))
    await inv('connections:list', true)
    check('Work signed out', !!(await lib.until(async () => (await view())?.observed?.loggedIn === false, HUNG_MS)))
    check('…the banner names the Assistant’s connection, signed out', !!(await lib.until(async () => (await banner.getAttribute('data-assistant-need').catch(() => null)) === 'signedOut' && /the Assistant's Codex account, is signed out/.test(await banner.innerText()), HUNG_MS)), await banner.innerText().catch(() => ''))
    await shots('signed-out')
    await banner.locator('[data-open-connections]').click()
    check('…its Open Accounts & Connections opens Settings → Accounts & Connections', !!(await lib.until(async () => (await page.locator('.settings-nav .row.selected[data-section="accounts"]').count()) === 1, HUNG_MS)))
    await page.locator('.activity-btn[aria-label="Projects"]').click()

    // --- Its CLI chosen, Claude Code, none of whose accounts is on here, Work (Codex) on: Assistant Settings… opens them.
    await inv('agents:update', assistantHome, 'assistant', { provider: 'claude-code' })
    check('its CLI chosen (Claude Code) with none on: named, with Assistant Settings…', !!(await lib.until(async () => (await banner.getAttribute('data-assistant-need').catch(() => null)) === 'noneFor' && /The Assistant runs on Claude Code/.test(await banner.innerText()) && (await banner.locator('[data-open-assistant-settings]').count()) === 1, HUNG_MS)), await banner.innerText().catch(() => ''))
    await shots('chosen-cli')
    await banner.locator('[data-open-assistant-settings]').click()
    check('…which opens the Assistant’s settings', !!(await lib.until(async () => (await page.locator('.dialog', { hasText: 'Assistant Settings' }).count()) === 1, HUNG_MS)))
    await page.keyboard.press('Escape')
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  process.exit(failed ? 1 : 0)
})()
