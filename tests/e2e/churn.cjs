// A card's back-and-forth (HI-3188, SPEC §16.11.5), in the window: a builder and a reviewer (fake Claude Code agents, each
// calling the Agent API with its own token) churn a card through reviewer requests until its simplify check, then its hard
// stop. The reviewer's next request is refused (409 loop.churnPending); For you offers each question's own choices; the
// board's card shows the count with each kind on hover; the user's answers resume the loop; and a level set to 0 closes an
// open question. Screenshots of For you and the badge, light and dark. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47836))
const userData = path.join(lib.WORK, 'churn-profile')
const ws = path.join(lib.WORK, 'churn-ws')
const claudeHome = path.join(lib.WORK, 'churn-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: alpha, env: lib.gitEnv(), encoding: 'utf8' }).trim()

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha, { 'a.txt': 'one\n', '.gitignore': '.combwork/\n' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 860 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    // Pair: a reviewer agent; the simplify check at 2 and the hard stop at 4, so a few requests reach each.
    const options = { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project', simplifyAt: 2, churnStopAt: 4 }
    await inv('workflow:setOptions', alpha, { preset: null, options })
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await lib.until(async () => (await live(builder.id))?.status === 'ready' && (await live(reviewer.id))?.status === 'ready', HUNG_MS)))

    // Each agent's own token, from its launch, as its Combwork tools read it.
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (id) => {
      const sessionId = (await live(id))?.sessionId
      const launch = await lib.until(() => launches().findLast((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const server = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const tokens = { builder: await tokenOf(builder.id), reviewer: await tokenOf(reviewer.id) }
    check('each agent has its own token', !!tokens.builder && !!tokens.reviewer)
    const call = async (token, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

    const n = (await inv('tasks:create', { title: 'Tidy the greeting', project: 'alpha' })).number
    const key = (await card(n)).key
    const ref = encodeURIComponent(key)
    const started = await call(tokens.builder, `/v1/tasks/${ref}/start`)
    check('the builder starts it', started.status === 200, JSON.stringify(started.body))
    const request = (text) => call(tokens.reviewer, `/v1/tasks/${ref}/request`, { text })
    const forYou = async () => (await inv('tasks:forYou', 'alpha')).items.filter((i) => i.card === n)

    // Two requests: the simplify check, asked once; the reviewer's next request refused while it waits.
    for (const t of ['Rename the function too', 'And its test']) check(`the reviewer asks: ${t}`, (await request(t)).status === 200)
    const simplify = await lib.until(async () => (await forYou()).find((i) => i.gate === 'simplify'), HUNG_MS)
    check('the simplify check is asked (For you, Decide)', !!simplify && simplify.kind === 'decide' && simplify.shown?.id === 'workflow.forYou.simplify', JSON.stringify(await forYou()))
    const paused = await request('One more edge case')
    check('a request while it waits is refused: 409 loop.churnPending, naming the question', paused.status === 409 && paused.body?.rule === 'loop.churnPending' && JSON.stringify(paused.body).includes(simplify?.request ?? '?'), JSON.stringify(paused.body))

    // The board's card shows the count, each kind on hover.
    await showBoard(page)
    const badge = page.locator(`.task-card[data-task="${n}"] [data-churn]`)
    check('the card shows its count', !!(await lib.until(async () => (await badge.getAttribute('data-churn').catch(() => null)) === '2', HUNG_MS)), String(await badge.getAttribute('data-churn').catch(() => null)))
    const tip = await lib.hoverTip(page, badge, (t) => t.includes('back-and-forth'), HUNG_MS)
    check('…its hover says each kind', tip.includes('2 rounds of back-and-forth') && tip.includes('2 reviewer requests'), tip)
    // The tooltip away first, so the shots show the card as it stands.
    await page.mouse.move(5, 5)
    await lib.until(async () => (await page.locator('.tip:visible').count()) === 0, HUNG_MS)
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.locator(`.task-card[data-task="${n}"]`).screenshot({ path: path.join(lib.WORK, `churn-badge-${theme}.png`) })
    }

    // For you in the card's dialog: the simplify check's three choices; Worth handling resumes the loop.
    await openByTitle(page, n)
    const dialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    const section = dialog.locator('[data-section="for-you"]')
    await section.waitFor({ timeout: HUNG_MS })
    const buttons = section.locator(`[data-request="${simplify?.request}"] .for-you-actions button`)
    check('For you offers the three choices', !!(await lib.until(async () => (await buttons.allInnerTexts()).join('|') === 'Worth handling: carry on|Simplify|Cut scope with follow-ups', HUNG_MS)), (await buttons.allInnerTexts()).join('|'))
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await section.screenshot({ path: path.join(lib.WORK, `churn-simplify-${theme}.png`) })
    }
    await buttons.first().click()
    check('answered: the question is gone', !!(await lib.until(async () => !(await forYou()).some((i) => i.gate === 'simplify'), HUNG_MS)), JSON.stringify(await forYou()))
    check('the reviewer may ask again', (await request('One more edge case')).status === 200)

    // On to 4: the hard stop, with the round limit's choices and a box for how much more.
    await request('And another')
    const stop = await lib.until(async () => (await forYou()).find((i) => i.gate === 'churnLimit'), HUNG_MS)
    check('the hard stop is asked', !!stop && stop.shown?.id === 'workflow.forYou.churnLimit', JSON.stringify(await forYou()))
    const stopButtons = section.locator(`[data-request="${stop?.request}"] .for-you-actions button`)
    check('…with carry on, split, accept and take over', !!(await lib.until(async () => (await stopButtons.allInnerTexts()).join('|') === 'Carry on|Split it|Accept with follow-ups|Take it over', HUNG_MS)), (await stopButtons.allInnerTexts()).join('|'))
    check('…and a box for how much more', (await section.locator(`[data-request="${stop?.request}"] .for-you-rounds`).innerText()).includes('More'))
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await section.screenshot({ path: path.join(lib.WORK, `churn-hardstop-${theme}.png`) })
    }
    await page.keyboard.press('Escape')

    // The hard stop set to 0: the question is closed, its count kept, and the loop goes on.
    await inv('workflow:setOptions', alpha, { preset: null, options: { ...options, churnStopAt: 0 } })
    check('a level set to 0 closes its open question', !!(await lib.until(async () => !(await forYou()).some((i) => i.gate === 'churnLimit'), HUNG_MS)), JSON.stringify(await forYou()))
    check('…and the reviewer may ask again', (await request('Last one')).status === 200)
    check('…the count kept', !!(await lib.until(async () => (await badge.getAttribute('data-churn').catch(() => null)) === '5', HUNG_MS)), String(await badge.getAttribute('data-churn').catch(() => null)))
    git('status', '--short')
    await inv('session:stop', alpha)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
