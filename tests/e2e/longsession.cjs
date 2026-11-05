// A long conversation: the transcript's size plain on the pane footer's right (#1013) and in its context's hover, then a warning in the
// footer past Settings → Sessions → Warn when a transcript is over (#978), with a notification once; clicking it opens Hand Over to… with the agent itself chosen, which
// carries the work on in a new conversation. Also the footer's context count opening the Overview at the agent's
// session. The agent runs the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'long-profile')
const ws = path.join(lib.WORK, 'long-ws')
const claudeHome = path.join(lib.WORK, 'long-claude-home')
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
  // The handover the new conversation reads (the fake CLI can't write one with Combwork's tools).
  const hdir = path.join(ws, '.combwork', 'shared', 'handovers')
  fs.mkdirSync(hdir, { recursive: true })
  fs.writeFileSync(path.join(hdir, '2026-10-01-alpha-long-work.md'), '# Long work\n\n- **Project:** alpha\n\nCarry on with the tests.\n')
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.sessions = { ...cfg.settings.sessions, transcriptWarnMB: 1 }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47899), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }

  await page.getByText('alpha', { exact: true }).first().click()
  await lib.addAgent(inv, alpha, { name: 'Coder' })
  const id = (await inv('workspace:get')).projects.find((p) => p.name === 'alpha').agents[0].id
  await inv('session:start', alpha, { agentId: id })
  await until(async () => (await live(id))?.status === 'waiting', HUNG_MS)
  await inv('pty:write', lib.ptyKey(alpha, id), '\r')
  await until(async () => (await live(id))?.status === 'ready', HUNG_MS)
  const key = lib.ptyKey(alpha, id)
  await inv('pty:write', key, 'hello')
  await lib.sleep(300)
  await inv('pty:write', key, '\r')
  await until(async () => (await live(id))?.status === 'finished', HUNG_MS)
  // Under the limit: plain, on the footer's right (#1013), and in the context's hover; not a warning (#978).
  const size = page.locator('.pane-footer-bar .foot-transcript')
  const ctxTip = page.locator('.tip .ctx-tip')
  const sized = await until(async () => {
    await page.locator('.pane-footer-bar .foot-ctx').hover().catch(() => undefined)
    return /Transcript: \d+(\.\d+)? KB/.test(await ctxTip.innerText().catch(() => ''))
  }, 15000)
  check("the context's hover has the transcript's size", !!sized, await ctxTip.innerText().catch(() => ''))
  await page.mouse.move(5, 5)
  check('under the limit it is not a warning', (await size.count()) === 0)
  const plain = page.locator('.pane-footer-bar .foot-size')
  check('…but plain in the line', (await plain.count()) === 1 && /\d+(\.\d+)? KB/.test(await plain.innerText()) && !(await plain.getAttribute('class')).includes('warn'), await plain.innerText().catch(() => ''))
  const firstSession = (await live(id)).sessionId

  // Past 1 MB: orange, one notification, and the size in the agent's activity.
  await inv('pty:write', key, 'pad 1200')
  await lib.sleep(300)
  await inv('pty:write', key, '\r')
  await until(async () => (await live(id))?.status === 'finished' && (await live(id)).transcriptBytes > 1024 * 1024, HUNG_MS)
  check('past the limit it is a warning in the line', !!(await until(async () => (await size.count()) === 1 && /MB/.test(await size.innerText()) && (await size.getAttribute('class')).includes('warn'), 15000)), await size.innerText().catch(() => ''))
  const toast = page.locator('.toast', { hasText: 'long conversation' })
  check('a notification says so, once', !!(await until(async () => (await toast.count()) === 1, 10000)))
  await page.screenshot({ path: path.join(lib.WORK, 'longsession.png') })

  // The context count opens the Overview at this agent's session.
  await page.locator('.pane-footer-bar .pane-foot-item', { hasText: 'ctx' }).click()
  const head = page.locator('.session-head')
  await head.waitFor({ timeout: 10000 }).catch(() => undefined)
  await lib.sleep(800)
  const inView = await head.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.top >= 0 && r.top < window.innerHeight
  }).catch(() => false)
  check("the context count opens the Overview at the agent's session", inView)
  await page.locator('.tab', { hasText: 'Session' }).first().click()
  await lib.sleep(500)

  // The size opens Hand Over to…, with the agent itself (a new conversation) chosen for a long one.
  await size.click()
  const dialog = page.locator('.dialog', { hasText: 'Hand over' })
  check('clicking the size opens Hand Over to…', !!(await until(async () => (await dialog.count()) === 1, 5000)))
  const self = dialog.locator('label.choice', { hasText: 'in a new conversation' })
  check('the agent itself is offered, and chosen', (await self.count()) === 1 && (await self.getAttribute('class')).includes('selected'))
  // The fake CLI can't write a handover: carry on from the latest one.
  await dialog.locator('input[type=checkbox]').uncheck().catch(() => undefined)
  await dialog.getByRole('button', { name: 'Hand Over' }).click()
  const fresh = await until(async () => {
    const s = await live(id)
    return s && s.sessionId && s.sessionId !== firstSession && s.status === 'finished' && s
  }, 60000)
  check('it carries on in a new conversation', !!fresh, JSON.stringify(await live(id)))
  const act = await inv('session:list', alpha)
  const rec = act.find((s) => s.id === fresh?.sessionId)
  check('which is linked to the old one', rec?.handedOverFrom === firstSession, JSON.stringify(rec && { from: rec.handedOverFrom }))
  check('and is short again: no warning', (fresh?.transcriptBytes ?? 0) < 1024 * 1024 && !!(await until(async () => (await size.count()) === 0, HUNG_MS)))

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
