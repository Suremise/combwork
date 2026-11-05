// Terminal text never stays garbled after the glyph atlas merges its pages (#1048). Terminals with the same font and
// colours share one WebGL glyph atlas; once it is full, drawing a new glyph merges its pages in the middle of a frame,
// and the cells already drawn in that frame showed other glyphs until something drew the terminal again (a scroll).
// A fake Claude Code agent's terminal is given chunks of new glyphs (CJK ideographs in 24-bit colours, the cursor
// hidden, as Claude Code hides it) until the atlas has merged several times; after each chunk, once the screen has
// settled, it shows the same as a full redraw of the same buffer. The merges are counted by the dev build's
// __hiveAtlasMerges, so a run that merged nothing fails rather than passing for nothing.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
/** Chunks to write at most: the atlas first merges after about 20, then about every 4th. */
const CHUNKS = 45
/** Merged pages to see (4 a merge, one terminal hearing them). */
const MERGED = 16

const userData = path.join(lib.WORK, 'atlasmerge-profile')
const ws = path.join(lib.WORK, 'atlasmerge-ws')
const claudeHome = path.join(lib.WORK, 'atlasmerge-claude-home')
const alpha = path.join(ws, 'alpha')
const ESC = '\x1b'
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
  lib.enableProviders(userData, ['claude-code'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47924), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1200, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'claude-code')
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    const agent = await lib.addAgent(inv, alpha, { name: 'Writer' })
    await inv('session:start', alpha, { agentId: agent.id })
    check('the agent starts', !!(await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === agent.id)?.status === 'ready', 25000)))
    const key = lib.ptyKey(alpha, agent.id)
    // Its terminal's screen (found by its key, which has backslashes a selector would need escaped).
    const marked = await lib.until(
      () =>
        page.evaluate((k) => {
          const el = [...document.querySelectorAll('[data-pty]')].find((e) => e.getAttribute('data-pty') === k)?.querySelector('.xterm-screen')
          if (el) el.id = 'atlasmerge-screen'
          return !!el
        }, key),
      HUNG_MS
    )
    check('its terminal is shown', !!marked)
    const screen = page.locator('#atlasmerge-screen')
    check('it draws with WebGL', !!(await lib.until(() => page.evaluate(() => window.__hiveWebglCount() === 1 && typeof window.__hiveAtlasMerges?.() === 'number'), HUNG_MS)))
    const merged = () => page.evaluate(() => window.__hiveAtlasMerges())
    const out = (d) => page.evaluate(([k, x]) => window.__hiveTerminalOutput(k, x), [key, d])
    /** The screen once two shots in a row are the same (what a write or a redraw set off has been drawn). */
    const settled = async () => {
      let last = await screen.screenshot()
      const same = await lib.until(async () => {
        const now = await screen.screenshot()
        const was = last
        last = now
        return now.equals(was)
      }, HUNG_MS)
      return same ? last : null
    }

    await out(`${ESC}[?25l${ESC}[2J${ESC}[H`)
    let seed = 1048
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8
    const stale = []
    let unsettled = 0
    let chunks = 0
    for (; chunks < CHUNKS && (await merged()) < MERGED; chunks++) {
      // 30 lines of glyphs it hasn't drawn before: a fast stream's chunk.
      let s = `${ESC}[?25l`
      for (let l = 0; l < 30; l++) {
        for (let c = 0; c < 40; c++) s += `${ESC}[38;2;${rnd() % 256};${rnd() % 256};${rnd() % 256}m${String.fromCodePoint(0x4e00 + (rnd() % 20000))}`
        s += `${ESC}[0m\r\n`
      }
      const before = await merged()
      await out(s)
      const shown = await settled()
      // A full redraw of the same buffer: scrolling up a line and back draws every row again.
      await page.evaluate((k) => {
        window.__hiveTerminalScrollLines(k, -1)
        window.__hiveTerminalScrollLines(k, 1)
      }, key)
      const redrawn = await settled()
      if (!shown || !redrawn) unsettled++
      else if (!shown.equals(redrawn)) {
        stale.push(`chunk ${chunks + 1}${(await merged()) > before ? ' (merged)' : ''}`)
        if (stale.length === 1) {
          fs.writeFileSync(path.join(lib.WORK, 'atlasmerge-shown.png'), shown)
          fs.writeFileSync(path.join(lib.WORK, 'atlasmerge-redrawn.png'), redrawn)
        }
      }
    }
    const total = await merged()
    check(`the atlas merged its pages while the terminal drew (${total} pages merged away in ${chunks} chunks)`, total >= MERGED, `${total} of ${MERGED}`)
    check('each chunk was drawn and settled', unsettled === 0, `${unsettled} didn't settle within ${HUNG_MS / 1000} s`)
    check('what the terminal shows after each chunk is what a full redraw shows: no glyphs left from before a merge', stale.length === 0, `${stale.join(', ')}; atlasmerge-shown.png and atlasmerge-redrawn.png in ${lib.WORK}`)
    await inv('session:stop', alpha, agent.id).catch(() => undefined)
  } catch (e) {
    check('the suite ran', false, e.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
