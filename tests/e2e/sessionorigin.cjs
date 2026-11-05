// The Sessions tab says where each session ran and whose it was: a badge on every Combwork session ("Coder · Project
// folder", "Reviewer · Worktree · hive/reviewer") and "Ran in …" over the selected transcript, as the session recorded.
// A removed agent's sessions say so ("Coder (removed)", or "Removed agent" for records from before names were kept),
// and never take the name of an agent added later with the same name or worktree. Resume still names the agent that
// resumes it now, and its menu gives every agent's location. New sessions record their agent's name.
// The agents run the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and Reviewer is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), for a session that ran outside the project folder.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf, putSessions } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'sessionorigin-profile')
const ws = path.join(lib.WORK, 'sessionorigin-ws')
const claudeHome = path.join(lib.WORK, 'sessionorigin-claude-home')
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
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47897), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }
  /** Starts an agent and has it answer one prompt, so Combwork keeps its session. */
  const runOnce = async (id) => {
    await inv('session:start', alpha, { agentId: id })
    await until(async () => ['waiting', 'ready'].includes((await live(id))?.status), HUNG_MS)
    if ((await live(id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    await until(async () => (await live(id))?.status === 'ready', HUNG_MS)
    await inv('pty:write', lib.ptyKey(alpha, id), 'hello')
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    return !!(await until(async () => (await live(id))?.status === 'finished', HUNG_MS))
  }
  // The records are in the workspace's database (#1061).
  const records = () => sessionsOf(alpha).sessions

  await page.getByText('alpha', { exact: true }).first().click()

  // --- A session records its agent's name.
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  check('Coder ran once', await runOnce(coder.id))
  const coderSession = (await live(coder.id)).sessionId
  const rec = records().find((r) => r.id === coderSession)
  check("the session records its agent's id and name", rec?.agentId === coder.id && rec?.agentName === 'Coder', JSON.stringify(rec))

  // --- Coder is removed, and a new agent takes the name.
  await inv('session:stop', alpha, coder.id)
  await until(async () => !(await live(coder.id)), HUNG_MS)
  await inv('agents:remove', alpha, coder.id, { deleteWorktree: false })
  const newCoder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  const helper = await lib.addAgent(inv, alpha, { name: 'Helper' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer', location: 'new-worktree' })
  check('the new Coder is another agent', newCoder.id !== coder.id)

  // --- Older history: a removed agent from before names were kept, an earlier agent in Reviewer's worktree, an
  // adopted session (no agent) and an archived one.
  const id = (n) => `0f5c2a8e-1111-4222-8333-94445555${String(n).padStart(4, '0')}`
  const at = '2026-10-01T10:00:00.000Z'
  const base = { agent: 'claude-code', createdAt: at, lastActiveAt: at, archived: false }
  const file = sessionsOf(alpha)
  file.sessions.push(
    { ...base, id: id(1), name: 'Before names', agentId: 'a-0ldname' },
    { ...base, id: id(2), name: 'Earlier spike', agentId: 'a-5p1ke00', agentName: 'Spike', cwd: reviewer.worktree.path, branch: 'hive/spike' },
    { ...base, id: id(3), name: 'Adopted one' },
    { ...base, id: id(4), name: 'Reviewer work', agentId: reviewer.id, agentName: 'Reviewer', cwd: reviewer.worktree.path, branch: reviewer.worktree.branch },
    { ...base, id: id(5), name: 'Put away', agentId: 'a-0ldname', archived: true }
  )
  putSessions(alpha, file)
  // A name to find the old Coder's session by (it is named by its start time).
  await inv('session:rename', alpha, coderSession, 'Old Coder work')

  await page.locator('.tab', { hasText: 'Sessions' }).click()
  await page.getByText('Archived', { exact: true }).click()
  await page.getByRole('button', { name: 'Expand All' }).click()
  const row = (name) => page.locator('.session-row', { hasText: name })
  // Each session sits under the agent that ran it (the tree's agent level), with where it ran on its badge.
  const badge = async (name) => {
    const where = (await row(name).locator('.session-origin').innerText().catch(() => '')).trim()
    const agent = await row(name)
      .evaluate((el) => {
        for (let e = el.previousElementSibling; e; e = e.previousElementSibling) if (e.classList.contains('session-branch-agent')) return e.querySelector('.label').textContent.trim()
        return ''
      })
      .catch(() => '')
    return `${agent} · ${where}`
  }
  check('rows load', !!(await until(async () => (await row('Put away').count()) === 1, 10000)))
  check("a removed agent's session keeps its name, not the new Coder's", (await badge('Old Coder work')) === 'Coder (removed) · Project folder', await badge('Old Coder work'))
  check('a record from before names were kept: Removed agent', (await badge('Before names')) === 'Removed agent · Project folder', await badge('Before names'))
  check("an earlier agent in Reviewer's worktree isn't Reviewer", (await badge('Earlier spike')) === 'Spike (removed) · Worktree · hive/spike', await badge('Earlier spike'))
  check('a worktree session of an agent that exists', (await badge('Reviewer work')) === `Reviewer · Worktree · ${reviewer.worktree.branch}`, await badge('Reviewer work'))
  check('an adopted session: not from an agent, its location only', (await badge('Adopted one')) === 'Not from an agent · Project folder', await badge('Adopted one'))
  check('an archived session is labelled too', (await badge('Put away')) === 'Removed agent · Project folder', await badge('Put away'))
  // Hovered again on each try: under load a first hover can land before the row is ready, and the tip shows after a delay.
  check('hover gives the full folder and the agent id', !!(await until(async () => {
    await row('Earlier spike').locator('.session-origin').hover().catch(() => undefined)
    const tip = await page.locator('.tip').last().innerText().catch(() => '')
    return tip.includes(reviewer.worktree.path) && tip.includes('a-5p1ke00')
  }, 8000)))
  await page.screenshot({ path: path.join(lib.WORK, 'sessionorigin-1-list.png') })

  // --- The selected session: where it ran, apart from who resumes it now.
  await row('Old Coder work').click()
  const ranIn = page.locator('.session-ran-in')
  check('the header says where it ran', !!(await until(async () => /Ran in\s+Coder \(removed\) · Project folder/.test(await ranIn.innerText().catch(() => '')), 5000)), await ranIn.innerText().catch(() => ''))
  // Helper is running: the menu still gives its location.
  check('Helper ran once', await runOnce(helper.id))
  const resume = page.locator('.transcript-toolbar .split-btn')
  check('Resume names the agent that resumes it now', /Resume in Coder/.test(await resume.innerText().catch(() => '')), await resume.innerText().catch(() => ''))
  await resume.getByRole('button', { name: 'Resume in another agent' }).click()
  const menu = page.locator('.menu').last()
  await until(async () => (await menu.count()) > 0, HUNG_MS)
  const menuText = await menu.innerText().catch(() => '')
  check('the menu gives each agent its location', /Coder\s*project folder/.test(menuText) && /Helper\s*project folder · running, its current session stops first/.test(menuText), menuText)
  await page.screenshot({ path: path.join(lib.WORK, 'sessionorigin-2-header.png') })
  await page.keyboard.press('Escape')

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
