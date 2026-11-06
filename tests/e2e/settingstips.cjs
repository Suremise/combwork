// A Settings row shows its ⓘ only when it has a tip (HI-2149: rows without one showed an ⓘ that opened an empty
// tooltip). Settings → Assistant: "MCP servers (this workspace)" (no tip) has no ⓘ, and every ⓘ in the section opens
// text; Settings → MCP Catalogues: "Catalogues" (no tip) has none; Settings → General: "Close to tray" keeps its ⓘ,
// which opens its tip. Screenshots in both themes. Dev build, throwaway profile and workspace, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const at = (x) => path.join(lib.WORK, `settingstips-${x}`)
const userData = at('profile')
const ws = at('ws')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1300, height: 800 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const row = (id) => page.locator(`[data-setting="${id}"]`)
    const section = async (label) => {
      await page.locator('.settings-nav .row', { hasText: label }).first().click()
      return page.locator('.settings-group').first()
    }
    const shot = async (name) => {
      for (const t of ['dark', 'light']) {
        await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t)
        await lib.sleep(200) // on purpose: the theme's colours settle
        await page.screenshot({ path: at(`${name}-${t}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    await page.keyboard.press('Control+,')

    // --- Settings → Assistant: the row without a tip has no ⓘ; each ⓘ shown opens text.
    const assistant = await section('Assistant')
    const mcp = row('assistant.mcp')
    check('Settings → Assistant shows "MCP servers (this workspace)"', !!(await lib.until(async () => (await mcp.count()) === 1, HUNG_MS)))
    await mcp.scrollIntoViewIfNeeded()
    check('…with no ⓘ (it has no tip)', (await mcp.locator('.info-icon').count()) === 0)
    const icons = assistant.locator('.info-icon')
    const n = await icons.count()
    check('…while its other rows keep theirs', n > 0, String(n))
    for (let i = 0; i < n; i++) {
      const icon = icons.nth(i)
      await icon.scrollIntoViewIfNeeded()
      const text = await lib.hoverTip(page, icon, (t) => t.trim().length > 0, HUNG_MS)
      check(`…ⓘ ${i + 1} of ${n} opens text`, !!text && text.trim().length > 0, JSON.stringify(text))
    }
    await page.mouse.move(5, 5)
    await mcp.scrollIntoViewIfNeeded()
    await shot('no-tip')

    // --- Settings → MCP Catalogues: Catalogues has no tip, so no ⓘ.
    await section('MCP Catalogues')
    const sources = row('mcpCatalogs.sources')
    check('Settings → MCP Catalogues shows "Catalogues"', !!(await lib.until(async () => (await sources.count()) === 1, HUNG_MS)))
    check('…with no ⓘ (it has no tip)', (await sources.locator('.info-icon').count()) === 0)

    // --- Settings → General: a row with a tip keeps its ⓘ, and it opens the tip.
    await section('General')
    const tray = row('general.closeToTray')
    check('Settings → General shows "Close to tray"', !!(await lib.until(async () => (await tray.count()) === 1, HUNG_MS)))
    const icon = tray.locator('.s-title .info-icon')
    check('…with its ⓘ', (await icon.count()) === 1)
    const tip = await lib.hoverTip(page, icon, (t) => t.includes('closing the window quits Combwork'), HUNG_MS)
    check('…which opens its tip', !!tip && tip.includes('closing the window quits Combwork'), JSON.stringify(tip))
    await shot('tip')
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
