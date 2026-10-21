// A GitHub Copilot pane is drawn at its own size from load (#486): Copilot's full-screen interface, drawn while its
// terminal had another size, stayed at the old width (stacked "Loading" frames, rules cut short) until the window was
// resized. The real Copilot CLI, offline against the scripted stand-in model (fake-copilot-api.cjs), in a folder it
// already trusts. Started while Settings hides its pane and the window changes size: its terminal is the process's size
// meanwhile (not xterm's 80 × 24); shown, it is fitted, and Hive gives Copilot a size refresh once it is ready. Started
// while the window changes size several times: the same. Switched live to Plan and back: a refresh after each.
// Restarted in another mode (Ask): the new process starts at the pane's size. Each time the screen is checked: one
// prompt, one header, full-width rules, no loading frames left. Accept edits' badge explains Copilot's own "Manual
// Approval" label. Copilot runs in a home of the suite's own with the GitHub CLI's login hidden: never the user's
// ~/.copilot or gh sign-in. Skipped where Copilot isn't installed.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'copilotsize-profile')
const ws = path.join(lib.WORK, 'copilotsize-ws')
const proj = path.join(ws, 'demo')
const copilotDir = path.join(lib.WORK, 'copilotsize-cli')
const copilotHome = path.join(copilotDir, 'copilot-home')
const apiLog = path.join(lib.WORK, 'copilotsize-api.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  if (!copilotInstalled()) lib.skip("environment: the GitHub Copilot CLI isn't installed (copilot)")
  for (const d of [userData, ws, copilotDir]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(apiLog, { force: true })
  lib.gitProject(proj, { 'a.ts': 'probe\n' })
  lib.enableProviders(userData, ['claude-code', 'copilot'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const api = await startFakeCopilotApi({ log: apiLog })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47820), ...copilotTestEnv(api, copilotDir, { above: lib.WORK }) })
  // The folder is trusted already (as "Yes, and remember this folder" saves it): Copilot goes straight to loading.
  fs.writeFileSync(path.join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [proj] }, null, 2))
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const hiveLog = path.join(userData, 'logs', 'hive.log')
  /** The size refreshes Hive has given Copilot so far ("cols × rows"). */
  const refreshes = () => {
    try {
      return [...fs.readFileSync(hiveLog, 'utf8').matchAll(/size refresh .*?: (\d+) × (\d+)/g)].map((m) => `${m[1]}x${m[2]}`)
    } catch {
      return []
    }
  }
  try {
    await lib.fitWindow(app, page, { width: 1000, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const info = await lib.until(async () => { const i = (await inv('provider:info')).copilot; return i && !i.checking ? i : null }, 60000, 500)
    check('Copilot found', !!info?.found, JSON.stringify(info && { found: info.found, path: info.path }))
    console.log(`Copilot CLI ${info?.version ?? '?'} (${info?.source ?? '?'}), offline against the stand-in at ${api.url}`)
    await lib.openWorkspace(inv, page, ws)
    const a = await inv('agents:add', proj, { name: 'Cop', provider: 'copilot', location: 'project' })
    const key = lib.ptyKey(proj, a.id)
    const live = async () => (await inv('session:live')).find((l) => l.agentId === a.id)
    const status = async () => (await live())?.status
    const ready = (ms = 30000) => lib.until(async () => (await status()) === 'ready', ms, 100)
    const stopped = () => lib.until(async () => !(await live()), 30000, 200)
    const term = () => page.evaluate((k) => window.__hiveTerminalState?.(k) ?? null, key)
    const lines = () => page.evaluate((k) => window.__hiveTerminalLines?.(k) ?? null, key)
    const settingsBtn = page.locator('.activity-btn[aria-label="Settings"]')
    const projectsBtn = page.locator('.activity-btn[aria-label="Projects"]')
    const resizeAt = (steps) => steps.map(([ms, w, h]) => new Promise((r) => setTimeout(() => void lib.fitWindow(app, page, { width: w, height: h }).then(r), ms)))

    /**
     * What a clean Copilot screen holds once it has settled, at the terminal's size: its header once, its prompt once,
     * every rule (a line of ─) as wide as the terminal, and no loading frame left over. A screen drawn at another
     * width has short rules, and stacked frames repeat the prompt or leave "Loading:" lines. Checked once Hive has given
     * Copilot its size refresh (the `refreshed`-th) and Copilot has redrawn: the screen as it is then, or after 10 s.
     */
    const cleanScreen = async (label, refreshed) => {
      check(`${label}: Hive gave Copilot a size refresh once it was ready`, !!(await lib.until(() => refreshes().length >= refreshed, 10000, 100)), JSON.stringify(refreshes()))
      const look = async () => {
        const t = await term()
        const pty = await inv('pty:size', key)
        const shown = (await lines()) ?? []
        const rules = shown.map((l) => l.match(/─+/g)?.sort((x, y) => y.length - x.length)[0] ?? '').filter((r) => r.length >= 10)
        const r = {
          t,
          pty,
          sized: !!t && !!pty && t.cols === pty.cols && t.rows === pty.rows,
          rules,
          short: rules.filter((x) => x.length < (t?.cols ?? 0) - 4),
          prompts: shown.filter((l) => /^\s*❯/.test(l)).length,
          headers: shown.filter((l) => /Copilot v[\d.]+ uses AI/.test(l)).length,
          loading: shown.filter((l) => /Loading:/.test(l)).length,
          text: shown.map((l) => l.trimEnd()).filter(Boolean).join(' | ')
        }
        r.clean = r.sized && r.rules.length > 0 && !r.short.length && r.prompts === 1 && r.headers === 1 && !r.loading
        return r
      }
      let r = await look()
      await lib.until(async () => (r = await look()).clean, 10000, 200)
      check(`${label}: the terminal and Copilot have the same size`, r.sized, JSON.stringify({ t: r.t, pty: r.pty }))
      check(`${label}: its rules are as wide as the terminal (${r.t?.cols} columns)`, r.rules.length > 0 && !r.short.length, `${r.rules.map((x) => x.length).join(', ')}: ${r.text}`)
      check(`${label}: one prompt and one header, no loading frames left`, r.prompts === 1 && r.headers === 1 && !r.loading, `${r.prompts} prompts, ${r.headers} headers, ${r.loading} loading: ${r.text}`)
    }

    // 1. Started while Settings hides the pane, the window changing size as it starts: the terminal is the process's
    // size meanwhile (output drawn into xterm's 80 × 24 landed in the wrong places), then fitted when shown.
    await settingsBtn.click()
    await inv('session:start', proj, { agentId: a.id })
    await Promise.all(resizeAt([[150, 1100, 760], [450, 960, 800]]))
    check('hidden: Copilot is ready', !!(await ready()), await status())
    const hiddenTerm = await term()
    const hiddenPty = await inv('pty:size', key)
    check('hidden: its terminal is the process’s size, not 80 × 24', !!hiddenTerm && !!hiddenPty && hiddenTerm.cols === hiddenPty.cols && hiddenTerm.rows === hiddenPty.rows, JSON.stringify({ hiddenTerm, hiddenPty }))
    await projectsBtn.click()
    await cleanScreen('hidden, then shown', 1)
    await page.screenshot({ path: path.join(lib.WORK, 'copilotsize-1-shown.png') })

    // 2. Started in view while the window changes size several times (a layout settling, display scaling).
    await inv('session:stop', proj, a.id)
    check('stopped', !!(await stopped()))
    const before = refreshes().length
    await inv('session:start', proj, { agentId: a.id })
    await Promise.all(resizeAt([[100, 900, 780], [300, 1050, 800], [500, 940, 760], [800, 1000, 800]]))
    check('resized while loading: Copilot is ready', !!(await ready()), await status())
    await cleanScreen('resized while loading', before + 1)
    const after = refreshes().slice(before)
    const t2 = await term()
    check('…its size refresh ends at the terminal’s size', after.length >= 1 && after.every((s) => s === `${t2?.cols}x${t2?.rows}`), JSON.stringify({ after, t2 }))
    await page.screenshot({ path: path.join(lib.WORK, 'copilotsize-2-load.png') })

    // Accept edits (Copilot's default): Hive's badge says why Copilot's own footer still says Manual Approval.
    check('Accept edits: the session runs in it', (await live())?.permissionMode === 'accept-edits', (await live())?.permissionMode)
    const badge = page.locator('.mode-badge', { hasText: 'Accept edits' }).first()
    await badge.hover()
    const tip = page.locator('.tip').last()
    const tipText = await lib.until(async () => ((await tip.count()) > 0 && (await tip.isVisible()) ? (await tip.innerText()).trim() || null : null), HUNG_MS)
    await page.mouse.move(5, 5)
    check('Accept edits: the mode badge explains Copilot’s “Manual Approval” label', /Manual Approval/.test(tipText ?? ''), tipText ?? 'no tooltip')

    // 3. A live mode switch (Shift+Tab to Plan, and back): Copilot gets a size refresh after each.
    for (const mode of ['plan', 'accept-edits']) {
      const n = refreshes().length
      const r = await inv('session:setMode', proj, a.id, mode)
      check(`switched live to ${mode}`, r?.ok === true && (await live())?.permissionMode === mode, JSON.stringify({ r, mode: (await live())?.permissionMode }))
      await cleanScreen(`switched live to ${mode}`, n + 1)
    }
    await page.screenshot({ path: path.join(lib.WORK, 'copilotsize-3-switched.png') })

    // 4. A mode switch that restarts it (Accept edits → Ask): the new process starts at the pane's size.
    const paneSize = await term()
    const beforeMode = refreshes().length
    await inv('session:restartInMode', proj, a.id, 'ask')
    const started = await lib.until(async () => { const l = await live(); return l && l.permissionMode === 'ask' ? await inv('pty:size', key) : null }, 30000, 50)
    check('restarted in Ask: Copilot starts at the pane’s size', !!started && started.cols === paneSize?.cols && started.rows === paneSize?.rows, JSON.stringify({ started, paneSize }))
    check('restarted in Ask: ready', !!(await ready()), await status())
    await cleanScreen('restarted in Ask', beforeMode + 1)
    await page.screenshot({ path: path.join(lib.WORK, 'copilotsize-4-mode.png') })

    await inv('session:stop', proj, a.id).catch(() => {})
    await stopped()
  } finally {
    await app.close().catch(() => {})
    await api.close()
  }
  if (failed) process.exitCode = 1
})().catch((e) => {
  console.error(e)
  console.log('FAIL the suite threw')
  process.exit(1)
})
