// The developer console showing text (#699): with Settings → Advanced → Developer console: show prompt, reply and
// command text off, the console's live view is redacted and says so, and a recording's text box starts unticked; turned
// on in Settings, the open console shows an "Unredacted" banner and, from then on, the prompt's text live (and after a
// pause, filled in with text), never a token in it, and a recording starts with text ticked; the agents' cw_console
// stays redacted meanwhile, and Copy Diagnostics names the setting; turned off, the banner goes and no text stays on
// screen.
// Fake Claude Code; dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'consoletext-profile')
const ws = path.join(lib.WORK, 'consoletext-ws')
const claudeHome = path.join(lib.WORK, 'consoletext-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47874))
const BASE = `http://127.0.0.1:${PORT}`
const SETTING = 'Developer console: show prompt, reply and command text'
// A prompt's words while the setting is off (never shown), while it is on (shown live), and while paused with it on.
const HIDDEN = 'otter-basalt-lagoon'
const SHOWN = 'falcon-amber-ridge'
const HELD = 'badger-cobalt-fern'
// A key in the prompt, an option's value and a device code (#699 round 1): masked whatever the setting says.
const KEY = 'sk-ant-api03-consoletextSecretKey0123456789'
// (An option's value is masked through the next option or the line's end, so the device code comes first.)
const MORE = ['enter ABCD-EFGH', '--api-key shortPrivateKey']
const LEAKS = [KEY, 'shortPrivateKey', 'ABCD-EFGH']
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.advanced = { ...cfg.settings.advanced, showDeveloperFeatures: true }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, devConsole: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (route) => {
      const r = await fetch(`${BASE}${route}`, { headers: { Authorization: `Bearer ${apiToken}` } })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const key = lib.ptyKey(alpha, b1.id)

    // --- The console, watching B1, with the setting off.
    await inv('console:open')
    const dc = await lib.until(() => app.windows().find((w) => w.url().endsWith('#console')) ?? null, HUNG_MS)
    if (!dc) throw new Error('no console window')
    dc.on('pageerror', (e) => check('no console page errors', false, e.message))
    await dc.locator('.dc-source').waitFor({ timeout: HUNG_MS })
    const source = await lib.until(async () => (await inv('console:sources')).find((s) => s.agentId === b1.id)?.id, HUNG_MS)
    await lib.until(async () => (await dc.locator(`.dc-source option[value="${source}"]`).count()) > 0, HUNG_MS)
    await dc.locator('.dc-source').selectOption(source)
    await lib.until(async () => (await inv('console:sources')).find((s) => s.agentId === b1.id)?.capturing, HUNG_MS)
    await inv('session:start', alpha, { agentId: b1.id })
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status === 'ready', HUNG_MS)

    const rows = () => dc.locator('.dc-row').evaluateAll((els) => els.map((e) => ({ seq: Number(e.dataset.seq), name: e.querySelector('.dc-name').textContent })))
    const promptRow = (after) => lib.until(async () => (await rows()).find((r) => r.name === 'UserPromptSubmit' && r.seq > after) ?? null, HUNG_MS)
    // A prompt's UserPromptSubmit row, picked: its Raw side as the window shows it.
    const promptShown = async (after) => {
      const r = await promptRow(after)
      if (!r) return { seq: 0, raw: '' }
      await dc.locator(`.dc-row[data-seq="${r.seq}"]`).click()
      await dc.locator('.dc-detail .dc-raw').waitFor({ timeout: HUNG_MS })
      return { seq: r.seq, raw: await dc.locator('.dc-detail .dc-raw').textContent() }
    }
    const ring = () => dc.evaluate((src) => window.hive.invoke('console:snapshot', src, 0), source)
    const recordBoxTicked = async () => {
      await dc.locator('.dc-record').click()
      const box = dc.locator('.dc-record-menu input[type="checkbox"]')
      await box.waitFor({ timeout: HUNG_MS })
      const ticked = await box.isChecked()
      await dc.locator('.dc-record-menu button', { hasText: 'Cancel' }).click()
      return ticked
    }

    check('off: no banner, and the status bar says redacted', (await dc.locator('.dc-unredacted').count()) === 0 && (await dc.locator('.dc-redaction').textContent()).startsWith('Redacted'))
    await lib.sendPrompt(inv, key, `edit a.ts ${HIDDEN}`, { submitted: async () => !!(await rows()).find((r) => r.name === 'UserPromptSubmit') })
    const hidden = await promptShown(0)
    check("…the prompt's words are hidden, only its length shown", hidden.raw.includes('<text:') && !hidden.raw.includes(HIDDEN), hidden.raw.slice(0, 300))
    check('…and a recording starts with its text box unticked', (await recordBoxTicked()) === false)
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status === 'ready', HUNG_MS)

    // --- On in Settings → Advanced: the open console says so at once.
    await page.locator('.activity-btn[aria-label="Settings"]').click()
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    const toggle = page.getByRole('switch', { name: SETTING })
    await toggle.click()
    await lib.until(async () => (await toggle.getAttribute('aria-checked')) === 'true', HUNG_MS)
    const banner = await lib.until(async () => ((await dc.locator('.dc-unredacted').count()) ? await dc.locator('.dc-unredacted').textContent() : null), HUNG_MS)
    check('on: the console shows an Unredacted banner', /Unredacted/.test(banner ?? '') && /stay masked/.test(banner ?? ''), String(banner))
    check('…and the status bar says so', (await dc.locator('.dc-redaction').textContent()).startsWith('Unredacted'))
    check('…the earlier prompt stays hidden (only what comes from now on has text)', !JSON.stringify(await ring()).includes(HIDDEN))

    await lib.sendPrompt(inv, key, `edit a.ts ${SHOWN} ${KEY} ${MORE.join(' ')}`, { submitted: async () => !!(await promptRow(hidden.seq)) })
    const shown = await promptShown(hidden.seq)
    await dc.screenshot({ path: path.join(lib.WORK, 'consoletext-on.png') })
    check("the live view shows the prompt's text", shown.raw.includes(SHOWN), shown.raw.slice(0, 300))
    const ringText = JSON.stringify(await ring())
    check("…with the key, the option's value and the device code in it masked", LEAKS.every((s) => !shown.raw.includes(s) && !ringText.includes(s)) && shown.raw.includes('--api-key <redacted>') && shown.raw.includes('enter <redacted>'), shown.raw.slice(0, 400))
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status === 'ready', HUNG_MS)

    // --- Paused, then resumed: what came meanwhile is filled in with its text.
    await dc.locator('.dc-pause').click()
    await lib.until(async () => (await dc.locator('.dc-live').textContent()).includes('Paused'), HUNG_MS)
    await lib.sendPrompt(inv, key, `edit a.ts ${HELD}`, { submitted: async () => /\(\d+ new\)/.test(await dc.locator('.dc-live').textContent()) })
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status === 'ready', HUNG_MS)
    await dc.locator('.dc-pause').click()
    const held = await promptShown(shown.seq)
    check('resume fills in what came while paused, with its text', held.raw.includes(HELD), held.raw.slice(0, 300))
    check('…and a recording starts with its text box ticked', (await recordBoxTicked()) === true)

    // --- The agents' cw_console stays redacted, and Copy Diagnostics names the setting.
    const read = await api(`/v1/console/events?agent=${encodeURIComponent(b1.id)}&project=alpha&seq=${held.seq}`)
    const readText = JSON.stringify(read.body)
    check("cw_console stays redacted while it's on", read.status === 200 && read.body?.events?.length === 1 && readText.includes('<text:') && !readText.includes(HELD) && !readText.includes(SHOWN), readText.slice(0, 400))
    const diagnostics = await inv('app:diagnostics', {})
    check('Copy Diagnostics names the setting', diagnostics.includes('hive.console.showText'), diagnostics.split('\n').find((l) => l.includes('Advanced settings')) ?? '')

    // --- Off again: the banner goes, and no text stays on screen.
    await toggle.click()
    await lib.until(async () => (await toggle.getAttribute('aria-checked')) === 'false', HUNG_MS)
    await lib.until(async () => (await dc.locator('.dc-unredacted').count()) === 0, HUNG_MS)
    check('off again: the banner goes', (await dc.locator('.dc-redaction').textContent()).startsWith('Redacted'))
    const screen = await lib.until(async () => {
      const text = await dc.locator('.dc').textContent()
      return text.includes(SHOWN) || text.includes(HELD) ? null : text
    }, HUNG_MS)
    check('…and no text stays on screen, nor in what the window reads', !!screen && !JSON.stringify(await ring()).match(new RegExp(`${SHOWN}|${HELD}`)))
    const after = await rows()
    check('…its events still listed, redacted', after.some((r) => r.seq === held.seq), JSON.stringify(after))
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
