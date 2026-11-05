// The Combwork Assistant's Compact highlight (#290): Settings → Assistant → Highlight Compact over (500,000 by default, its
// own, not Settings → Sessions' 200,000 for project agents). At or past it, Compact… in the Assistant's ⋯ (#979) is
// recommended ("Recommended: the context is over your threshold." under it) and its footer's context turns amber (with
// "— consider compacting"), as an agent's do; below it, or with Never, neither. A change in Settings shows at once. The
// Assistant runs the fake Claude Code (fake-claude/), whose "context N" makes its context about N tokens. Screenshots
// in both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'assistantcompact-profile')
const ws = path.join(lib.WORK, 'assistantcompact-ws')
const claudeHome = path.join(lib.WORK, 'assistantcompact-claude-home')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(path.join(ws, 'alpha'))
  // The fake trusts the workspace folder, where the Assistant runs.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // As saved by a Combwork from before the setting: Settings → Assistant without it.
  delete cfg.settings.assistant?.compactSuggestTokens
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47917), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  const settings = async () => inv('settings:get')

  check('a config without the setting gets 500,000; project agents keep 200,000', (await settings()).assistant.compactSuggestTokens === 500000 && (await settings()).sessions.compactSuggestTokens === 200000, JSON.stringify([(await settings()).assistant.compactSuggestTokens, (await settings()).sessions.compactSuggestTokens]))

  // --- The Assistant, with a conversation of about 300,000 tokens: past the agents' threshold, under its own.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  const panel = page.locator('.assistant-panel')
  const header = panel.locator('.assistant-header')
  await lib.until(async () => (await header.count()) === 1, 5000)
  await header.getByRole('button', { name: 'Start', exact: true }).click()
  check('the Assistant runs', !!(await lib.until(async () => (await live())?.status === 'ready', 20000)))
  await inv('pty:write', lib.ptyKey(home, 'assistant'), 'hello context 300000')
  await lib.sleep(300) // on purpose: the fake reads a typed line before its Enter, as a CLI does
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  check('it answers', !!(await lib.until(async () => (await live())?.status === 'finished', 20000)))
  const ctx = panel.locator('.assistant-footer .pane-foot-item', { has: page.locator('.ctx-text') })
  check('its footer shows the context, about 300k', !!(await lib.until(async () => /300/.test(await ctx.innerText().catch(() => '')), 10000)), await ctx.innerText().catch(() => ''))

  /** Compact… in the header's ⋯ (#979: the header's Compact button before), as its menu shows it: label and detail. */
  const compactItem = async () => {
    await header.getByRole('button', { name: 'More', exact: true }).click()
    const item = page.locator('.menu-item', { hasText: 'Compact…' })
    const text = await lib.until(async () => ((await item.count()) === 1 ? (await item.innerText()).replace(/\s+/g, ' ').trim() : null), HUNG_MS)
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.menu-item').count()) === 0, HUNG_MS)
    return text ?? ''
  }
  /** Whether Compact… is recommended (as an agent's ⋯ says it) and the footer's context highlighted. */
  const shown = async () => {
    const button = (await compactItem()).includes('Recommended')
    const footer = await ctx.evaluate((el) => el.classList.contains('warn'))
    return { button, footer }
  }
  /** A tooltip's text; a check that it doesn't say something fails if none showed (null). */
  const tooltip = async (target) => {
    await target.hover()
    const tip = page.locator('.tip').last()
    const text = await lib.until(async () => ((await tip.count()) > 0 && (await tip.isVisible()) ? (await tip.innerText()).trim() || null : null), HUNG_MS)
    await page.mouse.move(5, 5)
    await lib.until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
    return text ?? null
  }
  const says = async (target, text) => {
    const t = await tooltip(target)
    return t !== null && t.includes(text)
  }
  const saysNot = async (target, text) => {
    const t = await tooltip(target)
    return t !== null && !t.includes(text)
  }
  const highlighted = async (on) => lib.until(async () => JSON.stringify(await shown()) === JSON.stringify({ button: on, footer: on }), HUNG_MS)

  check("under 500,000 (but over the agents' 200,000): neither is highlighted", await highlighted(false), JSON.stringify(await shown()))
  check('…and neither says anything of it', !(await compactItem()).includes('Recommended') && (await saysNot(ctx, 'consider compacting')), JSON.stringify([await compactItem(), await tooltip(ctx)]))

  // --- Settings → Assistant → Highlight Compact over: 500,000 shown; 250,000 highlights both at once.
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).click()
  const row = page.locator('.setting', { has: page.locator('.s-title', { hasText: 'Highlight Compact over' }) })
  const box = row.locator('input[type=number]')
  const never = row.locator('label', { hasText: 'Never' }).locator('input')
  check('Settings → Assistant has Highlight Compact over, showing 500000', (await box.inputValue().catch(() => '')) === '500000', await box.inputValue().catch(() => 'no row'))
  const enter = async (text) => {
    await box.click()
    await box.press('Control+A')
    await box.press('Delete')
    await page.keyboard.type(text)
    await box.press('Enter')
    return lib.until(async () => (await settings()).assistant.compactSuggestTokens === Number(text), 5000)
  }
  check('250000 saves', await enter('250000'))
  check('…and both are highlighted at once', await highlighted(true), JSON.stringify(await shown()))
  check("…⋯'s Compact… recommends it, as an agent's does", (await compactItem()).includes('Recommended: the context is over your threshold.'), await compactItem())
  check("…the footer's says to consider compacting", await says(ctx, '— consider compacting'), await tooltip(ctx))
  check("project agents' threshold is unchanged", (await settings()).sessions.compactSuggestTokens === 200000)
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await page.screenshot({ path: path.join(lib.WORK, `assistantcompact-highlighted-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // --- Never: neither, whatever the context.
  await never.check()
  check('Never saves 0', !!(await lib.until(async () => (await settings()).assistant.compactSuggestTokens === 0, 5000)))
  check('…and neither is highlighted', await highlighted(false), JSON.stringify(await shown()))
  await never.uncheck()
  check('unticking Never brings back 250000, highlighted again', !!(await lib.until(async () => (await settings()).assistant.compactSuggestTokens === 250000, 5000)) && (await highlighted(true)), JSON.stringify(await shown()))

  // --- Back over the context: neither.
  check('400000 saves', await enter('400000'))
  check('…and neither is highlighted (the context is under it)', await highlighted(false), JSON.stringify(await shown()))
  check('…nor recommended', !(await compactItem()).includes('Recommended') && (await saysNot(ctx, 'consider compacting')), JSON.stringify([await compactItem(), await tooltip(ctx)]))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantcompact-under.png') })

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
