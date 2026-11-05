// Resume All Agents in the project header: resumes the stopped agents, leaves the running one alone, and reports
// an agent that can't resume (its worktree folder is gone) while the others still resume. The agents run the fake
// Claude Code (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and Tree is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'resumeall-profile')
const ws = path.join(lib.WORK, 'resumeall-ws')
const claudeHome = path.join(lib.WORK, 'resumeall-claude-home')
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
  lib.enableProviders(userData)
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
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }
  // Starts an agent, trusts its folder and has one exchange, so it has a conversation to resume.
  const run = async (id) => {
    await inv('session:start', alpha, { agentId: id })
    await until(async () => ['waiting', 'ready'].includes((await live(id))?.status), HUNG_MS)
    if ((await live(id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    await until(async () => (await live(id))?.status === 'ready', HUNG_MS)
    await inv('pty:write', lib.ptyKey(alpha, id), 'hello')
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    return until(async () => (await live(id))?.status === 'finished', HUNG_MS)
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const keep = await lib.addAgent(inv, alpha, { name: 'Keep' })
  const two = await lib.addAgent(inv, alpha, { name: 'Two' })
  const tree = await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
  for (const a of [keep, two, tree]) check(`${a.name} ran once`, !!(await run(a.id)))
  const keepSession = (await live(keep.id)).sessionId

  await inv('session:stop', alpha, two.id)
  await inv('session:stop', alpha, tree.id)
  check('Two and Tree stopped', !!(await until(async () => !(await live(two.id)) && !(await live(tree.id)), HUNG_MS)))
  // Tree's worktree folder goes, so it can't resume.
  const gone = await until(async () => {
    try {
      fs.rmSync(tree.worktree.path, { recursive: true, force: true })
    } catch {}
    return !fs.existsSync(tree.worktree.path)
  }, 10000)
  check("Tree's worktree folder removed", !!gone)
  await inv('workspace:refresh')

  // Resume (2) since #1035: a quiet button, its colour on its icon.
  const button = page.locator('.project-header .actions button.act-resume')
  check('Resume All shows while agents are stopped', !!(await until(async () => (await button.count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'resumeall-1-header.png') })
  // Its colours are a quiet Resume action button's (#344, #1035: a probe beside it), in both themes and on hover; an
  // agent's header has Resume as a quiet icon in the same colour as its icon (#977).
  await page.evaluate(() => {
    const b = document.createElement('button')
    b.id = 'resume-probe'
    b.className = 'btn act-resume quiet'
    b.textContent = 'Resume'
    document.querySelector('.project-header').appendChild(b)
  })
  const agentResume = page.locator('#resume-probe')
  const headerResume = page.locator('.pane-header-bar button.act-resume').first()
  const colours = (b) => b.evaluate((el) => ['color', 'background-color', 'border-color'].map((k) => getComputedStyle(el).getPropertyValue(k)).join(' | '))
  const seen = []
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await page.mouse.move(0, 0)
    await lib.sleep(400)
    const [all, one] = [await colours(button), await colours(agentResume)]
    seen.push(all)
    check(`${theme}: Resume All has the Resume button's colours`, all === one, `${all} vs ${one}`)
    const [allInk, iconInk] = [await button.locator('.codicon').evaluate((el) => getComputedStyle(el).color), await headerResume.evaluate((el) => getComputedStyle(el).color)]
    check(`${theme}: an agent header's Resume icon has its colour`, allInk === iconInk, `${allInk} vs ${iconInk}`)
    await agentResume.hover()
    const oneHover = await colours(agentResume)
    await button.hover()
    const allHover = await colours(button)
    check(`${theme}: and on hover`, allHover === oneHover && allHover !== all, `${allHover} vs ${oneHover}`)
    await page.screenshot({ path: path.join(lib.WORK, `resumeall-colours-${theme}.png`) })
  }
  check('the light theme has its own colours', seen[0] !== seen[1], seen.join(' / '))
  await page.evaluate(() => document.getElementById('resume-probe')?.remove())
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.mouse.move(0, 0)
  await button.click()

  check('Two resumed', !!(await until(async () => !!(await live(two.id)), HUNG_MS)))
  const toast = page.locator('.toast.error', { hasText: 'Tree' })
  check('the failure names the agent and why', !!(await until(async () => (await toast.count()) === 1, 10000)) && /worktree folder is missing/.test(await toast.innerText()), await toast.innerText().catch(() => ''))
  check('the failure says which agents did resume', /Resumed: Two/.test(await toast.innerText().catch(() => '')))
  check('Tree stays stopped', !(await live(tree.id)))
  const k = await live(keep.id)
  check('Keep was left alone (same session, not restarted)', !!k && k.sessionId === keepSession && k.status === 'finished', JSON.stringify(k))
  check('Two resumed its own conversation', (await live(two.id)).sessionId !== keepSession)
  await page.screenshot({ path: path.join(lib.WORK, 'resumeall-2-done.png') })

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
