// The Combwork Assistant after its conversation ends: the ended bar's Resume and New are buttons a real pointer can
// click (nothing of the terminal on top of them), Resume reopens the same conversation and New a fresh one, both work
// from the keyboard; the header's own Resume (|▷) resumes it without the ⋯ menu, also in a narrow panel and in the
// light theme; with no conversation to resume there is Start and no Resume. The Assistant runs the fake Claude Code
// (fake-claude/). Both Resume buttons out of the header (the ended bar's and the start page's) wear the amber tint
// of every other secondary Resume, in both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'assistantend-profile')
const ws = path.join(lib.WORK, 'assistantend-ws')
const claudeHome = path.join(lib.WORK, 'assistantend-claude-home')
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
  // Codex is on too (never run here): an Assistant switched to it has no conversation of its own to resume.
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47898), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const panel = page.locator('.assistant-panel')
  const header = panel.locator('.assistant-header')
  const ended = panel.locator('.assistant-ended')

  /** Clicks a button with the real pointer, after asking what is under its middle (it must be the button). */
  const pointAndClick = async (button, what) => {
    const box = await button.boundingBox()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const top = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py)
      const b = el?.closest('button')
      return { tag: el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}` : null, button: b ? b.textContent.trim() || b.getAttribute('aria-label') : null, cursor: el ? getComputedStyle(el).cursor : null }
    }, [x, y])
    check(`${what}: the pointer is over the button, with a pointer cursor`, top.button !== null && top.cursor !== 'text', JSON.stringify(top))
    await page.mouse.move(x, y)
    await page.mouse.click(x, y)
  }
  /** Says one prompt, so the conversation is kept. */
  const converse = async () => {
    await until(async () => (await live())?.status === 'ready', HUNG_MS)
    await inv('pty:write', lib.ptyKey(home, 'assistant'), 'hello')
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
    return !!(await until(async () => (await live())?.status === 'finished', HUNG_MS))
  }
  const stopFromHeader = async () => {
    await header.getByRole('button', { name: 'Stop', exact: true }).click()
    // It asks first while the conversation is going.
    const ask = page.locator('.dialog', { hasText: 'Stop session?' })
    if (await until(async () => (await ask.count()) === 1, HUNG_MS)) await ask.getByRole('button', { name: 'Stop', exact: true }).click()
    return !!(await until(async () => !(await live()) && (await ended.count()) === 1, HUNG_MS))
  }

  // --- No conversation yet: Start, and no Resume.
  await page.locator('.assistant-rail').click().catch(() => undefined)
  await until(async () => (await header.count()) === 1, 5000)
  check('with nothing to resume, the header has Start and no Resume', (await header.getByRole('button', { name: 'Start', exact: true }).count()) === 1 && (await header.getByRole('button', { name: 'Resume', exact: true }).count()) === 0)
  await header.getByRole('button', { name: 'Start', exact: true }).click()
  check('Start starts it, and it answers', await converse())
  const first = (await live()).sessionId

  // --- Stopped: the ended bar's Resume, with the real pointer.
  check('Stop ends the conversation and shows the ended bar', await stopFromHeader())
  const amber = async (button) => button.evaluate((b) => b.classList.contains('act-resume') && !b.classList.contains('subtle'))
  check("the ended bar Resume is amber, like the agents' Resume", await amber(ended.getByRole('button', { name: 'Resume' })))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantend-1-ended.png') })
  await inv('settings:update', { appearance: { theme: 'light' } }).catch(() => undefined)
  await lib.sleep(300)
  await page.screenshot({ path: path.join(lib.WORK, 'assistantend-1-ended-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } }).catch(() => undefined)
  await pointAndClick(ended.getByRole('button', { name: 'Resume' }), 'ended bar Resume')
  check('the ended bar Resume reopens the same conversation', !!(await until(async () => (await live())?.sessionId === first, HUNG_MS)), (await live())?.sessionId)

  // --- New, with the real pointer: a fresh conversation.
  await until(async () => (await live())?.status === 'ready', HUNG_MS)
  check('stopped again', await stopFromHeader())
  await pointAndClick(ended.getByRole('button', { name: 'New' }), 'ended bar New')
  const fresh = await until(async () => {
    const l = await live()
    return l && l.sessionId && l.sessionId !== first && l.sessionId
  }, HUNG_MS)
  check('the ended bar New opens a fresh conversation', !!fresh, String(fresh))
  check('which answers', await converse())

  // --- From the keyboard.
  check('stopped once more', await stopFromHeader())
  await ended.getByRole('button', { name: 'Resume' }).focus()
  await page.keyboard.press('Enter')
  check('Enter on the focused Resume resumes it', !!(await until(async () => (await live())?.sessionId === fresh, HUNG_MS)))
  await until(async () => (await live())?.status === 'ready', HUNG_MS)
  check('and stops', await stopFromHeader())
  await ended.getByRole('button', { name: 'New' }).focus()
  await page.keyboard.press('Space')
  const third = await until(async () => {
    const l = await live()
    return l && l.sessionId && l.sessionId !== fresh && l.sessionId
  }, HUNG_MS)
  check('Space on the focused New starts a fresh one', !!third)
  check('which answers too', await converse())

  // --- The header's own Resume (|▷), without the ⋯ menu.
  check('stopped for the header', await stopFromHeader())
  const headerResume = header.getByRole('button', { name: 'Resume', exact: true })
  check('the header shows Resume', !!(await until(async () => (await headerResume.count()) === 1, 5000)))
  check('with the |▷ icon', (await headerResume.locator('.codicon-debug-continue').count()) === 1)
  await pointAndClick(headerResume, 'header Resume')
  check('the header Resume reopens the same conversation', !!(await until(async () => (await live())?.sessionId === third, HUNG_MS)))

  // --- A narrow panel, in the light theme: Resume is still in the header.
  await until(async () => (await live())?.status === 'ready', HUNG_MS)
  check('stopped for the narrow panel', await stopFromHeader())
  await inv('settings:update', { appearance: { theme: 'light' } }).catch(() => undefined)
  await page.evaluate(() => window.hive.invoke('ui:setPane', 'assistant', 300))
  await page.reload()
  await until(async () => (await header.count()) === 1, 10000)
  check('narrow: Resume is still in the header', !!(await until(async () => (await header.getByRole('button', { name: 'Resume', exact: true }).count()) === 1, 5000)), String((await header.boundingBox())?.width))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantend-2-narrow-light.png') })
  await pointAndClick(header.getByRole('button', { name: 'Resume', exact: true }), 'narrow header Resume')
  check('and it resumes', !!(await until(async () => (await live())?.sessionId === third, HUNG_MS)))

  // --- Nothing it can resume: an Assistant now on Codex can't go back to a Claude Code conversation.
  await until(async () => (await live())?.status === 'ready', HUNG_MS)
  // Wide again, where Stop is a header button.
  await page.evaluate(() => window.hive.invoke('ui:setPane', 'assistant', 430))
  await page.reload()
  await until(async () => (await header.getByRole('button', { name: 'Stop', exact: true }).count()) === 1, 10000)
  // After a reload the panel shows its start page rather than the ended bar: stopped is what counts here.
  await stopFromHeader()
  check('stopped before switching provider', !(await live()))
  const idleResume = panel.locator('.assistant-idle').getByRole('button', { name: 'Resume', exact: true })
  check('the start page offers Resume', !!(await until(async () => (await idleResume.count()) === 1, 5000)))
  check("the start page Resume is amber, like the agents' Resume", await amber(idleResume))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantend-3-idle-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } }).catch(() => undefined)
  await lib.sleep(300)
  await page.screenshot({ path: path.join(lib.WORK, 'assistantend-4-idle-dark.png') })
  await inv('agents:update', home, 'assistant', { provider: 'codex' })
  await page.reload()
  await until(async () => (await header.count()) === 1, 10000)
  const idle = panel.locator('.assistant-idle')
  check('on Codex: Start, and no Resume in the header or the panel', !!(await until(async () => (await header.getByRole('button', { name: 'Start', exact: true }).count()) === 1, 5000)) && (await panel.getByRole('button', { name: 'Resume', exact: true }).count()) === 0 && (await idle.getByRole('button', { name: /Resume/ }).count()) === 0)
  await inv('agents:update', home, 'assistant', { provider: 'claude-code' })
  await page.reload()
  await until(async () => (await header.count()) === 1, 10000)
  check('back on Claude Code: Resume again', !!(await until(async () => (await header.getByRole('button', { name: 'Resume', exact: true }).count()) === 1, 5000)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
