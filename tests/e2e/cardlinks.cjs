// Card numbers in a terminal are links (#440): Ctrl+click on "#n" in an agent's or the Assistant's output opens card
// n, archived ones too; hovering shows its title and column. A number that isn't a card on the board, hex and a URL's
// fragment aren't linked, and a plain click doesn't open anything. A card's key (AM-12, #1221) is linked too, and an old
// key still is after the project's key changes; hovers name the card by its key. The agent and the Assistant run the fake Claude
// Code (fake-claude/), which prints each prompt back. Screenshots of the hover in both themes. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'cardlinks-profile')
const ws = path.join(lib.WORK, 'cardlinks-ws')
const claudeHome = path.join(lib.WORK, 'cardlinks-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  fs.mkdirSync(alpha, { recursive: true })
  lib.gitProject(alpha, { 'README.md': '# Alpha\n' })
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47865), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const live = async (proj, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
  const textAt = (key, text) => page.evaluate(([k, t]) => window.__hiveTerminalTextAt(k, t), [key, text])
  const hostTitle = () => page.evaluate(() => [...document.querySelectorAll('.terminal-host[title]')].map((h) => h.getAttribute('title')).join('|'))
  const dialog = page.locator('.dialog[role="dialog"]').first()
  const dialogTitle = () => dialog.locator('.task-title-input').inputValue().catch(() => '')
  const ctrlClick = async (pos) => {
    await page.keyboard.down('Control')
    await page.mouse.click(pos.x, pos.y)
    await page.keyboard.up('Control')
  }
  const closeDialog = async () => {
    await page.keyboard.press('Escape')
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
  }
  /**
   * Prints a prompt in a fake session (it echoes it back): typed once the fake takes prompts, and waited for by its own
   * turn (#684, lib.fakePrompts), then for its reply on screen.
   */
  const say = async (proj, id, prompt) => {
    const key = lib.ptyKey(proj, id)
    check(`the prompt "${prompt.slice(0, 40)}" is answered`, !!(await lib.fakePrompts(inv, key, () => live(proj, id), { home: claudeHome }).say(prompt)))
    await until(async () => String(await inv('pty:buffer', key)).includes(`Done: ${prompt}`), HUNG_MS)
  }
  /** A terminal's cell width in pixels. */
  const cellWidth = (key) => page.evaluate((k) => window.__hiveTerminalState(k).cols && document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"] .xterm-screen`).getBoundingClientRect().width / window.__hiveTerminalState(k).cols, key)
  /** Hovers `text` in a terminal (`skip` characters into it); the terminal's title once a link answers (empty if none). */
  const hover = async (key, text, skip = 0) => {
    const found = await textAt(key, text)
    if (!found) return null
    const at = { x: found.x + skip * (await cellWidth(key)), y: found.y }
    await page.mouse.move(at.x - 40, at.y - 40)
    await lib.sleep(150)
    await page.mouse.move(at.x + 4, at.y)
    await until(async () => (await hostTitle()) !== '', HUNG_MS)
    return { at, title: await hostTitle() }
  }

  // Cards: one on the board, one archived; 9999 isn't a card.
  const live1 = await inv('tasks:create', { title: 'Attention inbox', project: 'alpha', column: 'review' })
  const gone = await inv('tasks:create', { title: 'Old idea', project: 'alpha' })
  await inv('tasks:archive', gone.number, true)

  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Linker' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live(alpha, agent.id))?.status === 'ready', 20000)))
  const key = lib.ptyKey(alpha, agent.id)
  const A = `#${live1.number}`
  const G = `#${gone.number}`
  // Its key (#1221): linked too, and still after the project's key changes.
  const K = live1.key
  await say(alpha, agent.id, `card (${A}) and ${G}, not #9999 or #fff or https://x.test/a${A}; by key ${K}.`)
  check('the card numbers are printed', !!(await until(() => textAt(key, '#9999'), 10000)))

  // --- Not linked: an unknown number, hex, a URL's fragment.
  for (const [t, skip] of [['#9999', 0], ['#fff', 0], [`/a${A}`, 2]]) {
    const h = await hover(key, t, skip)
    check(`"${t}" isn't linked`, !!h && h.title === '', h?.title)
  }

  // --- A card's number: underlined, its title and column on hover; a plain click does nothing; Ctrl+click opens it.
  const h1 = await hover(key, `${A})`)
  check('a card number is linked, its title and column on hover', !!h1 && h1.title === `${K} Attention inbox · Review · Ctrl+click to open`, h1?.title)
  await page.mouse.click(h1.at.x + 4, h1.at.y)
  await lib.sleep(600)
  check("a plain click doesn't open it", (await dialog.count()) === 0)
  await ctrlClick({ x: h1.at.x + 4, y: h1.at.y })
  check('Ctrl+click opens the card', !!(await until(async () => (await dialog.count()) === 1 && (await dialogTitle()) === 'Attention inbox', 5000)), await dialogTitle())
  await closeDialog()

  // --- An archived card is linked too, and opens.
  const h2 = await hover(key, `${G},`)
  check('an archived card is linked, saying so', !!h2 && h2.title === `${gone.key} Old idea · Archived (from Todo) · Ctrl+click to open`, h2?.title)
  await ctrlClick({ x: h2.at.x + 4, y: h2.at.y })
  check('Ctrl+click opens the archived card', !!(await until(async () => (await dialog.count()) === 1 && ((await dialogTitle()) === 'Old idea' || /Old idea/.test(await dialog.innerText().catch(() => ''))), 5000)), await dialogTitle())
  await closeDialog()

  // --- A card's key (#1221): linked, its title on hover, Ctrl+click opens it; after the project's key changes, the old
  // key printed before still is.
  check('the card has a key', /^[A-Z]{2,4}-\d+$/.test(K ?? ''), K)
  const hk = await hover(key, `${K}.`)
  check("a card's key is linked, its title and column on hover", !!hk && hk.title === `${K} Attention inbox · Review · Ctrl+click to open`, hk?.title)
  await ctrlClick({ x: hk.at.x + 4, y: hk.at.y })
  check('Ctrl+click on the key opens the card', !!(await until(async () => (await dialog.count()) === 1 && (await dialogTitle()) === 'Attention inbox', 5000)), await dialogTitle())
  await closeDialog()
  const newKey = await inv('project:setKey', alpha, 'ALX')
  const renamed = `ALX-${K.split('-')[1]}`
  const hOld = await until(async () => {
    const h = await hover(key, `${K}.`)
    return h && h.title.startsWith(`${renamed} Attention inbox`) && h
  }, HUNG_MS)
  check('after a key change, the old key printed before is still linked, the hover naming the card by its new key', newKey === 'ALX' && !!hOld, (await hover(key, `${K}.`))?.title)
  await ctrlClick({ x: hOld.at.x + 4, y: hOld.at.y })
  check('…and Ctrl+click on it opens the card', !!(await until(async () => (await dialog.count()) === 1 && (await dialogTitle()) === 'Attention inbox', 5000)), await dialogTitle())
  await closeDialog()

  // --- The hover follows the board: a card moved since the line was printed shows its column now.
  await inv('tasks:update', live1.number, { column: 'passed' })
  const h3 = await until(async () => {
    const h = await hover(key, `${A})`)
    return h && /· Approved ·/.test(h.title) && h
  }, 5000)
  check('the hover shows the card as it is now', !!h3, (await hover(key, `${A})`))?.title)

  // --- The hover in both themes (the underline and pointer; the title is the system's tooltip).
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(500)
    await hover(key, `${A})`)
    await lib.sleep(300)
    await page.screenshot({ path: path.join(lib.WORK, `cardlinks-hover-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.mouse.move(5, 5)

  // --- The Assistant's panel: the same links.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  const panel = page.locator('.assistant-panel')
  await until(async () => (await panel.count()) === 1, 5000)
  await panel.locator('.assistant-header').getByRole('button', { name: 'Start', exact: true }).click()
  check('the Assistant runs', !!(await until(async () => (await live(home, 'assistant'))?.status === 'ready', 30000)))
  const akey = lib.ptyKey(home, 'assistant')
  await say(home, 'assistant', `${G} is archived; ${A} passed`)
  check("the Assistant's line is printed", !!(await until(() => textAt(akey, `${A} passed`), 10000)))
  const h4 = await hover(akey, `${A} passed`)
  check("a card number in the Assistant's output is linked", !!h4 && h4.title.startsWith(`${renamed} Attention inbox · Approved`), h4?.title)
  await ctrlClick({ x: h4.at.x + 4, y: h4.at.y })
  check("Ctrl+click in the Assistant's panel opens the card", !!(await until(async () => (await dialog.count()) === 1 && (await dialogTitle()) === 'Attention inbox', 5000)), await dialogTitle())
  await page.screenshot({ path: path.join(lib.WORK, 'cardlinks-assistant-opened.png') })
  await closeDialog()

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
