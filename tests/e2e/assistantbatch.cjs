// Start New (All) on a project with twelve agents leaves the Combwork Assistant's panel alone (#293): its terminal is the same
// one before and after (not re-mounted), keeps drawing (no WebGL context lost: Chromium drops the oldest context once a
// window holds too many, and terminals that ended didn't give theirs back), and the panel and its terminal keep their
// width. Three batches in a row, as a user starting fresh sessions a few times would; the test keeps every context
// alive, so only Combwork giving them back stops Chromium dropping one. A context lost anyway (the GPU) leaves a terminal
// drawn with the DOM and fitted again, not spilling past its panel. The agents and the Assistant run
// the fake Claude Code (fake-claude/). Screenshots before and after. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'assistantbatch-profile')
const ws = path.join(lib.WORK, 'assistantbatch-ws')
const claudeHome = path.join(lib.WORK, 'assistantbatch-claude-home')
const alpha = path.join(ws, 'alpha')
const AGENTS = 12
const BATCHES = 3
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  // The fake trusts the workspace folder (the Assistant's) and the project (the agents').
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47919), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  // xterm's WebGL renderer logs a lost context; Chromium warns when it drops the oldest one.
  const lost = []
  page.on('console', (m) => {
    if (/webglcontextlost|Too many active WebGL contexts|webgl context not restored/i.test(m.text())) lost.push(m.text())
  })
  await lib.fitWindow(app, page, { width: 1600, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const assistantKey = lib.ptyKey(home, 'assistant')
  const liveOf = async (proj, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }

  /**
   * Keeps the Assistant's terminal as it is now (its host and xterm elements) to compare with later, and listens once
   * for its WebGL canvas losing its context (xterm then waits 3 s, black, before drawing again with the DOM).
   */
  const remember = () =>
    page.evaluate((key) => {
      const host = document.querySelector(`.assistant-panel .terminal-host[data-pty="${CSS.escape(key)}"]`)
      const first = (window.__probeFirst = { host, xterm: host.querySelector('.xterm'), lost: false })
      for (const c of host.querySelectorAll('canvas')) c.addEventListener('webglcontextlost', () => (first.lost = true))
    }, assistantKey)
  /** The Assistant's panel and terminal as they are now; same: still the elements remember() kept (not re-mounted). */
  const state = () =>
    page.evaluate((key) => {
      const p = document.querySelector('.assistant-panel')
      const host = document.querySelector(`.assistant-panel .terminal-host[data-pty="${CSS.escape(key)}"]`)
      const first = window.__probeFirst
      const screen = host?.querySelector('.xterm-screen')
      const t = window.__hiveTerminalState?.(key)
      return {
        panel: p ? Math.round(p.getBoundingClientRect().width) : null,
        host: host ? Math.round(host.getBoundingClientRect().width) : null,
        screen: screen ? Math.round(screen.getBoundingClientRect().width) : null,
        cols: t?.cols ?? null,
        same: !!first && !!host && host === first.host && host.querySelector('.xterm') === first.xterm,
        lost: !!first?.lost,
        webgl: !!host?.querySelector('canvas:not(.xterm-link-layer)') && !host.querySelector('.xterm-rows')?.childElementCount,
        contexts: window.__hiveWebglCount?.() ?? null
      }
    }, assistantKey)
  // Every WebGL context the window makes is kept here: garbage collection, which used to give back the contexts of
  // terminals that ended (sooner or later), can't hide one Combwork didn't give back itself.
  await page.evaluate(() => {
    const made = (window.__probeContexts = [])
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = getContext.call(this, type, ...rest)
      if (ctx && /webgl/.test(type) && !made.includes(ctx)) made.push(ctx)
      return ctx
    }
  })
  /** Contexts still alive whose canvas left the page: a terminal that ended without giving its context back. */
  const leaked = () => page.evaluate(() => window.__probeContexts.filter((c) => !c.isContextLost() && !c.canvas.isConnected).length)

  // --- The Assistant, open and running first (as it usually is): its WebGL context is the window's oldest.
  await page.getByText('alpha', { exact: true }).first().click()
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  const panel = page.locator('.assistant-panel')
  await until(async () => (await panel.count()) === 1, 5000)
  // Every terminal the Assistant's panel mounts, from its start (HI-2213): main tells a run's start more than once (the
  // workspace's report, then its starting status, sometimes twice), and each used to make a new terminal. Under load the
  // last of them came after remember(); counted from the start, a re-mount shows whenever it comes.
  await page.evaluate(() => {
    const seen = (window.__probeMounts = [])
    new MutationObserver(() => {
      const host = document.querySelector('.assistant-panel .terminal-host')
      if (host && seen.at(-1) !== host) seen.push(host)
    }).observe(document.body, { childList: true, subtree: true })
  })
  const mounts = () => page.evaluate(() => window.__probeMounts.length)
  await panel.locator('.assistant-header').getByRole('button', { name: 'Start', exact: true }).click()
  check('the Assistant runs', !!(await until(async () => (await liveOf(home, 'assistant'))?.status === 'ready', HUNG_MS)))
  // Drawing with WebGL; kept, to tell a re-mount or a lost context later.
  await until(async () => (await state()).webgl, 10000)
  await remember()

  // --- Twelve agents, two pages of six; all running.
  const agents = []
  for (let n = 1; n <= AGENTS; n++) agents.push(await lib.addAgent(inv, alpha, { name: `${n <= 6 ? 'B' : 'R'}${((n - 1) % 6) + 1}` }))
  for (const a of agents) await inv('session:start', alpha, { agentId: a.id })
  const allReady = async (old = {}) => {
    const live = (await inv('session:live')).filter((s) => s.projectPath.toLowerCase() === alpha.toLowerCase())
    return agents.every((a) => {
      const l = live.find((s) => s.agentId === a.id)
      return l && l.sessionId && l.sessionId !== old[a.id] && ['ready', 'finished'].includes(l.status)
    })
  }
  check(`all ${AGENTS} agents run`, !!(await until(() => allReady(), 60000)))

  const before = await state()
  console.log('before', JSON.stringify(before))
  check('the Assistant draws with WebGL to begin with', before.webgl, JSON.stringify(before))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantbatch-1-before.png') })

  // --- Start New (All), a few times.
  for (let b = 1; b <= BATCHES; b++) {
    const old = Object.fromEntries(await Promise.all(agents.map(async (a) => [a.id, (await liveOf(alpha, a.id))?.sessionId])))
    await lib.agentsMenuRun(page, `Start New (${AGENTS})`)
    const asked = page.locator('.dialog', { hasText: 'Start new sessions for all agents?' })
    await until(async () => (await asked.count()) === 1, 5000)
    await asked.getByRole('button', { name: 'Start new', exact: true }).click()
    check(`batch ${b}: every agent has a new session`, !!(await until(() => allReady(old), 90000)))
    await lib.sleep(4000) // on purpose: a lost context would show within xterm's 3 s wait for it to come back
    const after = await state()
    console.log(`after batch ${b}`, JSON.stringify(after), `leaked ${await leaked()}`, lost.length ? JSON.stringify(lost) : '')
  }
  const after = await state()
  await page.screenshot({ path: path.join(lib.WORK, 'assistantbatch-2-after.png') })
  check("the Assistant's terminal is the same one (not re-mounted)", after.same, JSON.stringify(after))
  check("the Assistant's terminal kept its WebGL context", !after.lost, JSON.stringify(after))
  check("the Assistant's start made one terminal, however often its start was told", (await mounts()) === 1, `${await mounts()} mounted`)
  check('Chromium dropped no WebGL context', lost.length === 0, JSON.stringify(lost))
  check('every terminal that ended gave its WebGL context back', (await leaked()) === 0, `${await leaked()} still alive`)
  check('the Assistant still draws with WebGL', after.webgl, JSON.stringify(after))
  check('the panel keeps its width', after.panel === before.panel, `${before.panel} → ${after.panel}`)
  check('its terminal keeps its width and columns', after.host === before.host && after.screen === before.screen && after.cols === before.cols, `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  check('the terminal fits in its panel', after.screen !== null && after.screen <= after.host, JSON.stringify(after))

  // --- A context lost anyway (the GPU resets, say): xterm gives up on it after 3 s and Combwork's terminal draws with the
  // DOM; it still fits its panel, at the same width, with nothing spilling over.
  await page.evaluate((key) => {
    const host = document.querySelector(`.assistant-panel .terminal-host[data-pty="${CSS.escape(key)}"]`)
    for (const c of host.querySelectorAll('canvas')) c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
  }, assistantKey)
  // xterm gives up on it after 3 s, then the terminal is fitted again.
  await until(async () => {
    const t = await state()
    return !t.webgl && t.screen !== null && t.screen <= t.host
  }, 10000)
  const spill = () =>
    page.evaluate(() => {
      const t = document.querySelector('.assistant-terminal')
      const p = document.querySelector('.assistant-panel')
      return { terminal: t.scrollWidth - t.clientWidth, panel: p.scrollWidth - p.clientWidth }
    })
  const dom = await state()
  console.log('after a lost context', JSON.stringify(dom), JSON.stringify(await spill()))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantbatch-3-lost.png') })
  check('after a lost context the panel keeps its width', dom.panel === before.panel, `${before.panel} → ${dom.panel}`)
  check('…its terminal fits in it, with nothing spilling over', dom.screen !== null && dom.screen <= dom.host && JSON.stringify(await spill()) === JSON.stringify({ terminal: 0, panel: 0 }), `${JSON.stringify(dom)} ${JSON.stringify(await spill())}`)

  // --- The check tells a re-mount: a new conversation for the Assistant re-creates its terminal, and same says so.
  await inv('session:stop', home, 'assistant')
  await until(async () => !(await liveOf(home, 'assistant')), 15000)
  await inv('session:start', home, { agentId: 'assistant' })
  await until(async () => (await liveOf(home, 'assistant'))?.status === 'ready', HUNG_MS)
  const fresh =
    (await until(async () => {
      const t = await state()
      return t.host !== null && !t.same && t
    }, 10000)) || (await state())
  check('(the probe works) a new conversation re-mounts the terminal, and the check sees it', fresh && !fresh.same, JSON.stringify(fresh))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
