// The attention inbox: the status bar's "n need you" and its popover (oldest first, a click goes to the agent), the
// Projects badge and the project list's counts. A finish on screen is seen at once; one in another project stays
// until its pane is shown, told quietly beside the count ("1 finished", #1632), never as a need; a waiting agent (at a
// prompt) needs you until answered; an idle worktree agent with unmerged work is listed to review, not counted. The agents run the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace
// and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and Two is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'inbox-profile')
const ws = path.join(lib.WORK, 'inbox-ws')
const claudeHome = path.join(lib.WORK, 'inbox-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Git in the test repositories, waiting out the Combwork under test's own git (lib.git, #199).
const git = (cwd, ...a) => lib.git(cwd, a)
const shot = (page, name) => page.screenshot({ path: path.join(lib.WORK, `inbox-${name}.png`) })

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  for (const p of [alpha, beta]) {
    lib.gitProject(p)
    git(p, 'config', 'user.email', 't@t')
    git(p, 'config', 'user.name', 't')
  }
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47891), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  // Focus as the test says, not as Windows allows: Windows doesn't give a background app the focus while another window
  // has it (focus-stealing protection), so the window's focus is stubbed (as taskbar.cjs does) and the event Combwork
  // listens for is sent with it.
  const setFocus = (focused) =>
    app.evaluate(({ BrowserWindow }, f) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (!w.__focusStub) {
        const real = w.isFocused.bind(w)
        w.isFocused = () => (globalThis.__focused === undefined ? real() : globalThis.__focused)
        w.__focusStub = true
      }
      globalThis.__focused = f
      if (f) {
        // Back from minimised without taking the OS focus (the test copies never do: CW_TEST_QUIET).
        if (w.isMinimized()) w.showInactive()
        w.emit('focus')
      } else {
        w.minimize()
        w.emit('blur')
      }
    }, focused)
  const focusWindow = () => setFocus(true)
  const live = async (proj, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
  const turns = {}
  /** A prompt to an agent, and the end of its turn. */
  const turn = async (proj, id) => {
    const n = (turns[id] = (turns[id] ?? 0) + 1)
    // Typed once the fake takes prompts, and waited for by its own turn (#684, lib.fakePrompts).
    check(`${id}'s turn ${n} ends`, !!(await lib.fakePrompts(inv, lib.ptyKey(proj, id), () => live(proj, id), { home: claudeHome }).say(`${id} turn ${n}`)))
    await until(async () => String(await inv('pty:buffer', lib.ptyKey(proj, id))).includes(`Done: ${id} turn ${n}`), HUNG_MS)
    await lib.sleep(600)
  }
  const item = page.locator('.statusbar .inbox-item:not(.inbox-finished)')
  const itemText = async () => ((await item.count()) ? (await item.innerText()).trim() : '')
  // The quiet item beside it (#1632): agents finished since you last looked.
  const finishedItem = page.locator('.statusbar .inbox-finished')
  const finishedText = async () => ((await finishedItem.count()) ? (await finishedItem.innerText()).trim() : '')
  const rows = page.locator('.inbox-panel .inbox-row')
  const rowNames = async () => (await rows.locator('.inbox-name').allInnerTexts()).map((t) => t.trim())
  const projectsBadge = async () => {
    const b = page.locator('.activity-btn[aria-label="Projects"] .activity-badge')
    return (await b.count()) ? (await b.innerText()).trim() : ''
  }
  const needCount = async (name) => {
    const c = page.locator('.project-row', { hasText: name }).locator('.project-needs')
    return (await c.count()) ? (await c.innerText()).trim() : ''
  }
  const openProject = async (name) => {
    await page.locator('.project-row', { hasText: name }).first().click()
    await lib.sleep(600)
  }

  const one = await lib.addAgent(inv, alpha, { name: 'One' })
  const two = await lib.addAgent(inv, alpha, { name: 'Two', location: 'new-worktree' })
  const three = await lib.addAgent(inv, beta, { name: 'Three' })
  // beta isn't trusted: Three asks first, so it waits for you.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), two.worktree.path.toLowerCase()]))
  await inv('session:start', alpha, { agentId: one.id })
  await inv('session:start', alpha, { agentId: two.id })
  check('alpha\'s agents start', !!(await until(async () => (await live(alpha, one.id))?.status === 'ready' && (await live(alpha, two.id))?.status === 'ready', 20000)))
  await openProject('alpha')
  await focusWindow()
  check('the window has focus', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()))

  // A finish on screen is seen as it happens.
  await turn(alpha, one.id)
  check('a finish on screen: not unseen', (await live(alpha, one.id))?.unseen === false)
  check('…and nothing needs you', (await itemText()) === '', await itemText())
  check('…no Projects badge', (await projectsBadge()) === '')

  // Another project on screen: Three waits (it stays, seen or not), then One finishes unseen.
  await openProject('beta')
  await inv('session:start', beta, { agentId: three.id })
  check('Three asks whether to trust its folder', !!(await until(async () => (await live(beta, three.id))?.status === 'waiting', 15000)))
  await lib.sleep(800)
  check('a waiting agent on screen still needs you', !!(await until(async () => (await itemText()) === '1 needs you', 5000)), await itemText())
  await turn(alpha, one.id)
  check('a finish in another project stays unseen', (await live(alpha, one.id))?.unseen === true)
  // #1632's case: one agent at a prompt, another finished: 1 needs you, and the finish told apart.
  check('the status bar says 1 needs you: the finish is not a need', !!(await until(async () => (await itemText()) === '1 needs you' && (await finishedText()) === '1 finished', 5000)), `${await itemText()} | ${await finishedText()}`)
  const needTip = await lib.hoverTip(page, item, (t) => t.includes('1 agent needs you'))
  check('…its tooltip says what it counts: cards and agents, each once (HI-1931)', needTip.includes('1 agent needs you'), needTip)
  const finishedTip = await lib.hoverTip(page, finishedItem, (t) => t.startsWith('Agents that finished'))
  check('…and the quiet item what it counts', finishedTip.startsWith('Agents that finished since you last looked'), finishedTip)
  await page.mouse.move(5, 5)
  check('the Projects badge says 1', (await projectsBadge()) === '1', await projectsBadge())
  check('each project counts what needs you', (await needCount('alpha')) === '' && (await needCount('beta')) === '1', `${await needCount('alpha')} ${await needCount('beta')}`)
  await shot(page, '0-statusbar')

  // The compact sidebar: a count on each project's square.
  await page.keyboard.press('Control+Alt+B')
  const railCounts = () => page.locator('.rail-project .project-need-count').allInnerTexts()
  check('the compact sidebar shows the counts too', !!(await until(async () => JSON.stringify(await railCounts()) === '["1"]', HUNG_MS)), JSON.stringify(await railCounts()))
  await shot(page, '0-rail')
  await page.keyboard.press('Control+Alt+B')
  await until(async () => (await page.locator('.rail-project').count()) === 0, HUNG_MS)

  await item.click()
  check('the popover lists them oldest first', !!(await until(async () => JSON.stringify(await rowNames()) === JSON.stringify(['beta · Three', 'alpha · One']), HUNG_MS)), JSON.stringify(await rowNames()))
  check('…saying what each is doing', (await rows.nth(0).locator('.inbox-state').innerText()).startsWith('Needs input') && (await rows.nth(1).locator('.inbox-state').innerText()) === 'Finished')
  check('…and how long ago', (await rows.nth(1).locator('.inbox-time').innerText()) === 'just now')
  const sections = await page.locator('.inbox-panel .inbox-section').allInnerTexts()
  check('…the finished apart, under their own heading', JSON.stringify(sections.map((t) => t.trim().toUpperCase())) === JSON.stringify(['NEED YOU (1)', 'FINISHED (1)']), JSON.stringify(sections))
  await shot(page, '1-popover')

  // A click goes to the agent, which is then seen.
  await rows.nth(1).click()
  check('the popover closes', !!(await until(async () => (await page.locator('.inbox-panel').count()) === 0, HUNG_MS)))
  check('alpha is shown', !!(await until(async () => (await page.locator('.project-row.selected', { hasText: 'alpha' }).count()) === 1, HUNG_MS)))
  check('One is seen once shown', !!(await until(async () => (await live(alpha, one.id))?.unseen === false, 5000)))
  check('one left: Three, still waiting', !!(await until(async () => (await itemText()) === '1 needs you' && (await finishedText()) === '', 5000)), `${await itemText()} | ${await finishedText()}`)

  // A finish while the window is minimised is unseen until the window comes back.
  await setFocus(false)
  const backgrounded = await until(async () => !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())), 5000)
  if (backgrounded) {
    await turn(alpha, one.id)
    check('a finish while the window is in the background is unseen', (await live(alpha, one.id))?.unseen === true)
    await focusWindow()
    check('…and seen once the window has focus again', !!(await until(async () => (await live(alpha, one.id))?.unseen === false, 5000)))
  } else console.log('SKIP the window could not be minimised')

  // A worktree agent with unmerged work, idle and seen: to review, not counted.
  fs.writeFileSync(path.join(two.worktree.path, 'b.ts'), 'export const b = 2\n')
  git(two.worktree.path, 'add', '-A')
  git(two.worktree.path, 'commit', '-q', '-m', 'b')
  await focusWindow()
  await turn(alpha, two.id)
  check('Two finished on screen is seen', (await live(alpha, two.id))?.unseen === false)
  const branch = await until(async () => (await inv('agents:branchStatuses')).find((b) => b.agentId === two.id && b.status?.ahead === 1)?.status, 8000)
  check('its branch has a diff summary', branch?.diff?.files === 1 && branch.diff.insertions === 1, JSON.stringify(branch))
  await item.click()
  await lib.sleep(400)
  const review = page.locator('.inbox-panel .inbox-row', { hasText: 'alpha · Two' })
  check('Two is listed to review', !!(await until(async () => (await review.count()) === 1, 5000)))
  check('…with its summary', (await review.locator('.inbox-state').innerText().catch(() => '')) === '1 file, +1 −0 · 1 commit', await review.locator('.inbox-state').innerText().catch(() => ''))
  check('…not counted', (await itemText()) === '1 needs you', await itemText())
  await shot(page, '2-review')
  await review.getByRole('button', { name: 'Changes' }).click()
  check('Changes opens the Git tab at Changes', !!(await until(async () => (await page.locator('.tab.active', { hasText: 'Version Control' }).count()) === 1 && (await page.locator('.git-sections button.active', { hasText: 'Changes' }).count()) === 1, HUNG_MS)))

  // Answering Three: nothing needs you, and the status bar says what is left to review.
  await lib.acceptClaudeTrust(inv, beta, three.id)
  check('Three is answered', !!(await until(async () => (await live(beta, three.id))?.status === 'ready', 15000)))
  check('the status bar shows 1 to review', !!(await until(async () => (await itemText()) === '1 to review', 5000)), await itemText())
  check('no Projects badge', (await projectsBadge()) === '')
  await shot(page, '3-review-only')

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
