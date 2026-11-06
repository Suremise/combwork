// A hidden terminal draws nothing while its program prints (HI-1827). xterm redraws a terminal's selection (every row) on
// each scroll, even while it has stopped drawing because the terminal is hidden; a pane hidden for a while draws with the
// DOM renderer, which measured every cell again in each redraw (its widths are 0 while hidden, never cached), and with a
// dozen agents printing behind Settings the window froze for 5–17 s at a time. Hardware acceleration is off here, so the
// pane draws with the DOM renderer at once (as one does after 30 s hidden). A word in a fake Claude Code agent's terminal
// is selected; behind Settings, its output scrolls the terminal and its rows are never touched meanwhile. Back on
// Projects, it draws what was printed, and its selection as it stands (xterm clears it if the pane's height changes).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'hiddenredraw-profile')
const ws = path.join(lib.WORK, 'hiddenredraw-ws')
const claudeHome = path.join(lib.WORK, 'hiddenredraw-claude-home')
const proj = path.join(ws, 'alpha')
const WORD = 'hidden-redraw-marker'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(proj)
  const env = lib.fakeClaude(userData, claudeHome, [proj])
  // Settings → Advanced → hardware acceleration off: terminals skip xterm's WebGL renderer.
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'cw.disableHardwareAcceleration': true } }))
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, CW_API_PORT: lib.port(47924) }, viewport: { width: 1200, height: 800 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    check('hardware acceleration is off (the setting)', (await inv('app:info')).gpu?.off === true, JSON.stringify((await inv('app:info')).gpu))
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    const agent = await lib.addAgent(inv, proj, { name: 'Writer' })
    const key = lib.ptyKey(proj, agent.id)
    await inv('session:start', proj, { agentId: agent.id })
    check('the agent starts', !!(await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === agent.id)?.status === 'ready', HUNG_MS)))
    // The key holds a path: quoted as a CSS string, its backslashes stay.
    const hostSelector = `.terminal-host[data-pty=${JSON.stringify(key)}]`
    const pane = page.locator(hostSelector)
    check('its terminal draws with the DOM renderer', !!(await lib.until(async () => (await pane.locator('.xterm-rows > div').count()) > 0, HUNG_MS)))
    const print = (data) => page.evaluate(([k, d]) => window.__cwTerminalOutput(k, d), [key, data])
    const state = () => page.evaluate((k) => window.__cwTerminalState(k), key)
    const selection = () => page.evaluate((k) => window.__cwTerminalSelection(k), key)
    const selectionDrawn = () => pane.locator('.xterm-selection > div').count()

    // A word selected (double-click), as a user would before looking elsewhere.
    // Again while it isn't: the pane's fit settling (a change of height) clears a selection, and the CLI's redraw for its
    // new size the word itself.
    const wordAt = () => page.evaluate(([k, w]) => window.__cwTerminalTextAt(k, w), [key, WORD])
    const selected = await lib.until(async () => {
      if ((await selection()) === WORD && (await selectionDrawn()) > 0) return true
      // On a row of its own: the rest of the row erased (HI-1979: printed at the cursor in Claude Code's input box, the
      // word landed on the box's rule, and a double-click took the rule's characters with it).
      if (!(await wordAt())) await print(`\r\n${WORD}\x1b[K\r\n`)
      const at = await wordAt()
      if (at) await page.mouse.dblclick(at.x, at.y)
      return false
    }, HUNG_MS, 500)
    check('a word in it is selected', !!selected, JSON.stringify({ selection: await selection(), drawn: await selectionDrawn() }))

    await page.locator('.activity-btn[aria-label="Settings"]').click()
    await page.locator('.settings').waitFor({ timeout: HUNG_MS })
    check('Settings hides the terminal', !!(await lib.until(async () => !(await pane.isVisible()), HUNG_MS)))
    // Every change to the hidden terminal's rows and selection from here on.
    await page.evaluate((sel) => {
      const host = document.querySelector(sel)
      window.__hiddenChanges = 0
      window.__hiddenWatch = new MutationObserver((m) => (window.__hiddenChanges += m.length))
      for (const el of host.querySelectorAll('.xterm-rows, .xterm-selection')) window.__hiddenWatch.observe(el, { childList: true, subtree: true, characterData: true, attributes: true })
    }, hostSelector)
    const before = await state()
    const lines = Array.from({ length: 2 * before.rows }, (_, i) => `printed while hidden ${i + 1}`)
    await print(lines.map((l) => `${l}\r\n`).join(''))
    const after = await state()
    check('its output scrolls the hidden terminal', after.baseY > before.baseY, JSON.stringify({ before, after }))
    // The selection's redraws come on the next frame (xterm's requestAnimationFrame): two frames on, all have come.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const changes = await page.evaluate(() => {
      window.__hiddenWatch.disconnect()
      return window.__hiddenChanges
    })
    check('the hidden terminal draws nothing while its program prints', changes === 0, `${changes} changes to its rows and selection`)

    await page.locator('.activity-btn[aria-label="Projects"]').click()
    // As drawn (the DOM renderer's rows) is what its buffer holds: the lines printed while hidden, drawn once shown.
    const drawn = () => pane.evaluate((h) => [...h.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent.replace(/\u00a0/g, ' ').trimEnd()))
    const held = async () => ((await page.evaluate((k) => window.__cwTerminalLines(k), key)) ?? []).map((l) => l.trimEnd())
    const same = await lib.until(async () => {
      const [d, h] = [await drawn(), await held()]
      return d.length > 0 && d.join('\n') === h.join('\n') && d.includes(lines.at(-1))
    }, HUNG_MS)
    check('shown again, it draws what was printed while hidden', !!same, JSON.stringify({ drawn: (await drawn()).slice(-3), held: (await held()).slice(-3) }))
    // Its selection is drawn as it stands: the word if it is still selected (xterm clears a selection when the terminal's
    // height changes, as fitting it on its return can), nothing if not. Scrolled up a few lines at a time until the
    // selected line is in view (where depends on how often the CLI's redraws wiped the word before it was selected).
    const asItStands = async () => {
      if ((await selection()) === '') return (await selectionDrawn()) === 0
      if ((await selectionDrawn()) > 0) return true
      await page.evaluate((k) => window.__cwTerminalScrollLines(k, -3), key)
      return false
    }
    check('its selection is drawn as it stands', !!(await lib.until(asItStands, HUNG_MS, 200)), JSON.stringify({ selection: await selection(), drawn: await selectionDrawn(), state: await state() }))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
