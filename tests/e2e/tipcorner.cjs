// The tip card and toasts keep out of the way of buttons in their corner: with the Combwork Assistant's panel open they sit
// left of it, so the panel's ended bar (Resume, New) is never covered; with it hidden, they sit just above the
// bottom-right agent pane's ended bar. Each button is clicked with the real pointer, after checking it is what lies
// under its middle. Tips are on in this suite's profile, finished notices off. The agents run the fake Claude Code (fake-claude/). Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'tipcorner-profile')
const ws = path.join(lib.WORK, 'tipcorner-ws')
const claudeHome = path.join(lib.WORK, 'tipcorner-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: true }
  // No "finished" entries: any notification closes a tip showing, a bell-only one too (HI-2424), and the Assistant's
  // finish (bell-only once its panel is folded) closed it before its corner was measured (HI-2513).
  cfg.settings.notifications = { ...cfg.settings.notifications, notifyOnFinished: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47899), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const card = page.locator('.tip-card')
  const panel = page.locator('.assistant-panel')
  const header = panel.locator('.assistant-header')
  const box = (loc) => loc.boundingBox()
  const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  /** Clicks a button with the real pointer, after checking it is what lies under its middle. */
  const pointAndClick = async (button, what) => {
    const b = await button.boundingBox()
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    const top = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py)
      return { tag: el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}` : null, button: !!el?.closest('button') }
    }, [x, y])
    check(`${what}: nothing covers it`, top.button, JSON.stringify(top))
    await page.mouse.click(x, y)
  }
  /** Starts an agent (or the Assistant), has it answer once, and stops it. */
  const runAndStop = async (p, id) => {
    await inv('session:start', p, { agentId: id })
    await until(async () => (await live(p, id))?.status === 'ready', HUNG_MS)
    await inv('pty:write', lib.ptyKey(p, id), 'hello')
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(p, id), '\r')
    await until(async () => (await live(p, id))?.status === 'finished', HUNG_MS)
    const sid = (await live(p, id)).sessionId
    await inv('session:stop', p, id)
    await until(async () => !(await live(p, id)), HUNG_MS)
    return sid
  }

  check("a tip shows (tips are on in this suite's profile)", !!(await until(async () => (await card.count()) === 1, 10000)))

  // --- The Assistant's panel open, its conversation ended: the card is left of the panel.
  if ((await panel.count()) === 0) await page.locator('.assistant-rail').click()
  await until(async () => (await header.count()) === 1, 5000)
  const first = await runAndStop(home, 'assistant')
  const ended = panel.locator('.assistant-ended')
  await until(async () => (await ended.getByRole('button', { name: 'Resume' }).count()) === 1, 10000)
  await lib.sleep(300)
  const p1 = await box(panel)
  const c1 = await box(card)
  check('with the Assistant open, the card sits left of its panel', c1 && p1 && c1.x + c1.width <= p1.x, JSON.stringify({ card: c1, panelLeft: p1?.x }))
  await page.screenshot({ path: path.join(lib.WORK, 'tipcorner-1-assistant.png') })
  await pointAndClick(ended.getByRole('button', { name: 'Resume' }), "the Assistant's Resume")
  check('and Resume reopens its conversation', !!(await until(async () => (await live(home, 'assistant'))?.sessionId === first, HUNG_MS)))
  await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)
  await inv('session:stop', home, 'assistant')
  await until(async () => !(await live(home, 'assistant')), HUNG_MS)
  await until(async () => (await ended.getByRole('button', { name: 'New' }).count()) === 1, 10000)
  await pointAndClick(ended.getByRole('button', { name: 'New' }), "the Assistant's New")
  check('and New starts a fresh one', !!(await until(async () => {
    const l = await live(home, 'assistant')
    return l && l.sessionId && l.sessionId !== first
  }, HUNG_MS)))
  await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)
  await inv('session:stop', home, 'assistant')

  // --- The Assistant hidden, an agent's session ended: the card is in the window's corner, above the pane's bar.
  // Hidden from the header's ⋯ (#979: the header's own Hide button went into it).
  await header.getByRole('button', { name: 'More', exact: true }).click()
  await page.locator('.menu .menu-item', { hasText: 'Fold the Assistant panel' }).click()
  await until(async () => (await panel.count()) === 0, 5000)
  await page.getByText('alpha', { exact: true }).first().click()
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  const done = await runAndStop(alpha, coder.id)
  const bar = page.locator('.agent-pane-body .session-ended')
  await until(async () => (await bar.count()) === 1, 10000)
  await lib.sleep(300)
  check('the tip still shows (no notification closed it)', (await card.count()) === 1, JSON.stringify(await page.evaluate(() => window.__cwBell?.())))
  const b2 = await box(bar)
  const c2 = await box(card)
  check('with the Assistant hidden, the card is in the window corner', c2 && c2.x + c2.width > 1400, JSON.stringify(c2))
  check("and above the pane's ended bar", c2 && b2 && !overlaps(c2, b2) && c2.y + c2.height <= b2.y, JSON.stringify({ card: c2, bar: b2 }))
  await page.screenshot({ path: path.join(lib.WORK, 'tipcorner-2-pane.png') })
  // Resume is enabled once the workspace knows the session it resumes.
  const paneResume = bar.getByRole('button', { name: 'Resume', exact: true })
  await until(async () => (await paneResume.count()) === 1 && (await paneResume.isEnabled()), 10000)
  await pointAndClick(paneResume, "the pane's Resume")
  check("and the pane's Resume reopens its session", !!(await until(async () => (await live(alpha, coder.id))?.sessionId === done, HUNG_MS)))
  await until(async () => (await live(alpha, coder.id))?.status === 'ready', HUNG_MS)
  await inv('session:stop', alpha, coder.id)
  await until(async () => (await bar.count()) === 1, 10000)

  // --- A toast, stacked above the card: also clear of the bar.
  // The terminal had the focus (the card steps aside over a focused terminal): take it away, and the card is back.
  await page.evaluate(() => document.activeElement?.blur())
  await until(async () => !(await card.getAttribute('class')).includes('stepped-aside'), HUNG_MS)
  await page.screenshot({ path: path.join(lib.WORK, 'tipcorner-3-lifted.png') })
  await card.getByRole('button', { name: "Don't show tips" }).click()
  const toast = page.locator('.toast', { hasText: 'Tips are off' })
  await until(async () => (await toast.count()) === 1, 5000)
  await lib.sleep(300)
  const t3 = await box(toast)
  const b3 = await box(bar)
  check("a toast keeps clear of the pane's ended bar", t3 && b3 && !overlaps(t3, b3), JSON.stringify({ toast: t3, bar: b3 }))
  await pointAndClick(bar.getByRole('button', { name: /New Session/ }), "the pane's New Session")
  check('and New Session starts a fresh one', !!(await until(async () => {
    const l = await live(alpha, coder.id)
    return l && l.sessionId && l.sessionId !== done
  }, HUNG_MS)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
