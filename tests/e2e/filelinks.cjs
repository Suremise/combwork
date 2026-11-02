// File paths in an agent's terminal are links: Ctrl+click opens the file in the Files tab at its line (in the
// agent's worktree for a worktree agent, in another project for a path into it). Only files that exist are
// linked, with a tooltip in the window's language as it shows (HI-2346), and a plain click doesn't open anything. The agents run the fake Claude Code (fake-claude/), which
// prints each prompt back. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and Two is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), for links into a folder other than the project's.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'filelinks-profile')
const ws = path.join(lib.WORK, 'filelinks-ws')
const claudeHome = path.join(lib.WORK, 'filelinks-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `// ${tag} line ${i + 1}`).join('\n') + '\n'

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(path.join(alpha, 'src'), { recursive: true })
  fs.mkdirSync(path.join(alpha, 'my docs'), { recursive: true })
  lib.gitProject(alpha, { 'src/app.ts': lines(40, 'app'), 'README.md': '# Alpha\n', 'my docs/my notes.ts': lines(20, 'notes') })
  fs.mkdirSync(path.join(beta, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(beta, 'lib', 'util.js'), lines(10, 'util'))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47898), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const live = async (proj, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
  const textAt = (key, text) => page.evaluate(([k, t]) => window.__hiveTerminalTextAt(k, t), [key, text])
  // Where `text` is drawn once the turn of `prompt` has ended on screen (its "Done:" line with the input drawn below it),
  // read in one go in the window, so the position is the one drawn with that end: the fake Claude Code's screen changes
  // as a turn ends (its working lines go), which can move the lines under the mouse.
  const drawnAt = async (k, text, prompt) => {
    const at = await until(() => page.evaluate(([termKey, t, done]) => {
      const drawn = window.__hiveTerminalLines(termKey) ?? []
      const end = drawn.findIndex((l) => l.includes(done))
      return end >= 0 && drawn.slice(end + 1).some((l) => l.includes('? for shortcuts')) ? window.__hiveTerminalTextAt(termKey, t) : null
    }, [k, text, `Done: ${prompt}`]), 15000)
    check(`"${text}" is drawn, its turn's end below it`, !!at)
    return at ?? { x: 0, y: 0 }
  }
  const fileTree = page.locator('.file-tree')
  const selectedRow = () => page.locator('.file-row.selected').getAttribute('data-rel').catch(() => null)
  const activeLine = () => page.locator('.monaco .active-line-number').first().innerText().catch(() => '')
  const ctrlClick = async (pos) => {
    await page.keyboard.down('Control')
    await page.mouse.click(pos.x, pos.y)
    await page.keyboard.up('Control')
  }
  const backToSession = async () => {
    await page.locator('.tabs .tab').first().click()
    await lib.sleep(400)
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const one = await lib.addAgent(inv, alpha, { name: 'Linker' })
  const two = await lib.addAgent(inv, alpha, { name: 'Two', location: 'new-worktree' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), two.worktree.path.toLowerCase()]))
  await inv('session:start', alpha, { agentId: one.id })
  await inv('session:start', alpha, { agentId: two.id })
  check('the agents start', !!(await until(async () => (await live(alpha, one.id))?.status === 'ready' && (await live(alpha, two.id))?.status === 'ready', 20000)))

  const key = lib.ptyKey(alpha, one.id)
  // Short enough that its turn's "Done:" line holds all three paths on one row in a pane half the window wide.
  const first = 'see src/app.ts:25:4 ../beta/lib/util.js:3 src/nope.ts'
  await inv('pty:write', key, first)
  await lib.sleep(200)
  await inv('pty:write', key, '\r')
  check('the paths are printed', !!(await until(() => textAt(key, 'src/nope.ts'), 10000)))
  check('its turn ends', !!(await until(async () => (await live(alpha, one.id))?.status === 'finished', 15000)))
  const linkTitle = () => page.locator('.terminal-host[title="Open in Files · Ctrl+click"]').count()

  // --- A missing file isn't linked; an existing one is.
  const nope = await drawnAt(key, 'src/nope.ts', first)
  await page.mouse.move(nope.x + 4, nope.y)
  await lib.sleep(700)
  check("a file that doesn't exist isn't linked", (await linkTitle()) === 0)
  const app1 = await drawnAt(key, 'src/app.ts:25:4', first)
  await page.mouse.move(app1.x + 4, app1.y)
  check('an existing file is linked, with a tooltip', !!(await until(async () => (await linkTitle()) === 1, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'filelinks-1-hover.png') })
  // Its tooltip is a message, in the window's language as it shows (HI-2346): a language changed meanwhile, as main
  // sends it, applies to the same terminal's next hover; then back to English.
  const lang = (await inv('app:info')).language
  const speak = (code, messages) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: { ...lang, code, locale: code, messages } })
  await speak('de', { 'files.links.title': 'In Dateien öffnen · Strg+Klick' })
  await page.mouse.move(nope.x + 4, nope.y)
  await until(async () => (await linkTitle()) === 0, HUNG_MS)
  await page.mouse.move(app1.x + 4, app1.y)
  check('…in the language chosen since the terminal opened', !!(await until(async () => (await page.locator('.terminal-host[title="In Dateien öffnen · Strg+Klick"]').count()) === 1, HUNG_MS)))
  await speak(lang.code, lang.messages)
  await page.mouse.move(nope.x + 4, nope.y)
  await until(async () => (await page.locator('.terminal-host[title]').count()) === 0, HUNG_MS)

  // --- A plain click is just a click.
  await page.mouse.click(app1.x + 4, app1.y)
  await lib.sleep(600)
  check("a plain click doesn't open it", (await fileTree.count()) === 0)

  // --- Ctrl+click: the Files tab, the file selected, the cursor on its line.
  await ctrlClick({ x: app1.x + 4, y: app1.y })
  check('Ctrl+click opens the Files tab', !!(await until(async () => (await fileTree.count()) === 1, 5000)))
  check('with the file selected', !!(await until(async () => (await selectedRow()) === 'src/app.ts', 5000)), String(await selectedRow()))
  check('at its line', !!(await until(async () => (await activeLine()) === '25', 10000)), await activeLine())
  check('in the project folder', (await page.locator('.root-select').inputValue().catch(() => '')) === '')
  await page.screenshot({ path: path.join(lib.WORK, 'filelinks-2-opened.png') })

  // --- A path into another workspace project opens there.
  await backToSession()
  const util = await drawnAt(key, '../beta/lib/util.js:3', first)
  await ctrlClick({ x: util.x + 4, y: util.y })
  check('a path into another project opens in that project', !!(await until(async () => /beta/.test(await page.locator('h1').first().innerText().catch(() => '')) && (await selectedRow()) === 'lib/util.js', 5000)), String(await selectedRow()))
  check('at its line too', !!(await until(async () => (await activeLine()) === '3', 10000)), await activeLine())

  // --- A worktree agent's path opens in its worktree.
  await page.getByText('alpha', { exact: true }).first().click()
  await backToSession()
  const key2 = lib.ptyKey(alpha, two.id)
  await inv('pty:write', key2, 'see src/app.ts:7')
  await lib.sleep(200)
  await inv('pty:write', key2, '\r')
  check("the worktree agent's path is printed", !!(await until(() => textAt(key2, 'src/app.ts:7'), 10000)))
  check('its turn ends too', !!(await until(async () => (await live(alpha, two.id))?.status === 'finished', 15000)))
  const wt = await drawnAt(key2, 'src/app.ts:7', 'see src/app.ts:7')
  await page.mouse.move(wt.x + 4, wt.y)
  await lib.sleep(500)
  await ctrlClick({ x: wt.x + 4, y: wt.y })
  check("it opens in the agent's worktree", !!(await until(async () => (await page.locator('.root-select').inputValue().catch(() => '')) === two.id && (await selectedRow()) === 'src/app.ts', 5000)))
  check('at line 7', !!(await until(async () => (await activeLine()) === '7', 10000)), await activeLine())
  await page.screenshot({ path: path.join(lib.WORK, 'filelinks-3-worktree.png') })

  // --- Review findings: a path printed in other case opens the file as it is spelled on disk (Windows ignores
  // case; the Files tree doesn't), and a path with spaces is one link, quoted or not.
  await backToSession()
  for (const prompt of ['see SRC/APP.TS:9 and "my docs/my notes.ts":4', 'then my docs/my notes.ts:6', 'not "docs/missing README.md":2']) {
    await inv('pty:write', key2, prompt)
    await lib.sleep(200)
    await inv('pty:write', key2, '\r')
    await until(async () => String(await inv('pty:buffer', key2)).includes(`Done: ${prompt}`), 15000)
    await until(async () => (await live(alpha, two.id))?.status === 'finished', 15000)
  }
  check('the paths are printed', !!(await until(() => textAt(key2, 'SRC/APP.TS:9'), 10000)) && !!(await textAt(key2, 'my notes.ts:6')))
  // A quoted path that isn't a file: README.md inside it exists in the worktree, but isn't linked on its own.
  const last = 'not "docs/missing README.md":2'
  const inQuote = await drawnAt(key2, 'README.md":2', last)
  await page.mouse.move(inQuote.x + 4, inQuote.y)
  await lib.sleep(700)
  check("a piece of a quoted path that isn't a file isn't linked", (await linkTitle()) === 0)
  const upper = await drawnAt(key2, 'SRC/APP.TS:9', last)
  await page.mouse.move(upper.x + 4, upper.y)
  await lib.sleep(500)
  await ctrlClick({ x: upper.x + 4, y: upper.y })
  check('a path in other case selects the file', !!(await until(async () => (await selectedRow()) === 'src/app.ts', 5000)), String(await selectedRow()))
  check('and shows its line', !!(await until(async () => (await activeLine()) === '9', 10000)), await activeLine())
  for (const [printed, line] of [['my notes.ts":4', '4'], ['my notes.ts:6', '6']]) {
    await backToSession()
    // On the path's last name: the link is the whole path, spaces and all.
    const at = await drawnAt(key2, printed, last)
    await page.mouse.move(at.x + 4, at.y)
    await lib.sleep(500)
    await ctrlClick({ x: at.x + 4, y: at.y })
    check(`a path with spaces opens (${printed})`, !!(await until(async () => (await selectedRow()) === 'my docs/my notes.ts', 5000)), String(await selectedRow()))
    check(`at line ${line}`, !!(await until(async () => (await activeLine()) === line, 10000)), await activeLine())
  }

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
