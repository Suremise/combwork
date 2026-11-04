/**
 * Runs inside the Sandbox, as the user, with the host's Node, Hive's own playwright-core and Hive's tests folder (this
 * file's, tests\sandbox\inside, is in it) mapped read-only by the Sandbox checks (tests\sandbox\checks.cjs):
 *   C:\tools\node\node.exe C:\tools\hive-tests\sandbox\inside\drive.cjs <step> <prefix>
 * Drives the installed Hive (%LOCALAPPDATA%\Programs\Hive\Hive.exe, its real profile %APPDATA%\Hive) with Playwright's
 * _electron, as Hive's e2e suites do, and writes C:\out\<prefix>.json ({ step, checks: [{ id, scenario, name, ok, detail }],
 * facts, shots, completed }) and window PNGs C:\out\<prefix>-<name>.png. completed is true only once the whole step ran
 * (the file is saved as it goes, so an interrupted step leaves a record without it). Network off, fake CLIs only.
 * Steps:
 *   first-run     scenarios 1 and 2: the first screen, no-CLI banners, Provider Setup's three providers, both themes
 *   cli-appears   scenario 3: Claude Code turned on, a stand-in installer puts the e2e fake on the user PATH, and
 *                 Provider Setup's "Check again" finds it without restarting Hive
 *   workspace     scenario 6: a new workspace in the fresh install (its .combwork, views and status), for the fresh-install comparison
 *   mark          scenario 4, before the upgrade: change two settings (user name, theme)
 *   after-upgrade scenario 4, after it: those settings kept, the version, a screenshot
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { _electron } = require(process.env.PW_CORE || 'C:\\tools\\playwright')

const [step, prefix] = process.argv.slice(2)
const OUT = 'C:\\out'
// The installed app (HI-2460): Combwork's when it is installed, else Hive Desktop's (1.0, before an upgrade). Its
// profile: Combwork's folder when it is there, else Hive's (HI-2461's fallback, and 1.0's own).
const COMBWORK_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'Combwork', 'Combwork.exe')
const HIVE1_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'Hive', 'Hive.exe')
const HIVE_EXE = fs.existsSync(COMBWORK_EXE) ? COMBWORK_EXE : HIVE1_EXE
const PROFILE = [path.join(process.env.APPDATA, 'Combwork'), path.join(process.env.APPDATA, 'Hive')].find((p) => fs.existsSync(p)) ?? path.join(process.env.APPDATA, HIVE_EXE === COMBWORK_EXE ? 'Combwork' : 'Hive')
// A file the upgrade must carry across in the local profile folder (accounts live there), written before it.
const LOCAL_MARK = 'sandbox-mark.txt'
// A connection's Claude Code home in the local folder (HI-2520): its folder trust must arrive as it was, nothing more
// trusted. One folder trusted, one answered no; a third never listed must stay unlisted.
const TRUST_HOME = path.join('accounts', 'a-sandbox')
const TRUST_JSON = { hasCompletedOnboarding: true, projects: { 'C:/Sandbox/trusted': { hasTrustDialogAccepted: true }, 'C:/Sandbox/untrusted': { hasTrustDialogAccepted: false } } }
const MARK = { userName: 'Sandbox Check', theme: 'light' }
// Scenario 4's workspace, made before the upgrade and opened after it (HI-2506), and its card.
const KEPT_WS = path.join(process.env.USERPROFILE, 'Workspaces', 'Kept')
const KEPT_CARD = 'Made before the upgrade'
const res = { step, prefix, at: new Date().toISOString(), checks: [], facts: {}, shots: [] }
const save = () => fs.writeFileSync(path.join(OUT, `${prefix}.json`), JSON.stringify(res, null, 2))
// Each check has a stable id ("<scenario>.<what>"): the host's report requires the ids each step must produce.
const check = (id, name, ok, detail) => { res.checks.push({ id, scenario: Number(String(id).split('.')[0]) || 0, name, ok: !!ok, detail: ok ? undefined : String(detail ?? '').slice(0, 1500) }); save() }
// When what it reads is ready: conditions Hive says are met, each bounded (ready.cjs, unit-tested in hive's npm test).
const { until, workspaceSetUp, VIEWS, viewReady } = require(path.join(__dirname, 'ready.cjs'))
const ps = cmd => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60_000 }).trim()
const readConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(PROFILE, 'config.json'), 'utf8')) } catch { return null } }

let app
let page
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.hive.invoke(c, ...a), [channel, args])

/** Hive instances already running from the install folder (the installer's --force-run starts one): closed by PID. */
function closeRunningHive() {
  const out = ps(`$p = Get-CimInstance Win32_Process -Filter "Name='${path.basename(HIVE_EXE)}'" | Where-Object { $_.ExecutablePath -eq '${HIVE_EXE.replace(/'/g, "''")}' }; foreach ($x in $p) { $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue; if ($g -and $g.MainWindowHandle -ne 0) { [void]$g.CloseMainWindow() } }; Start-Sleep -Seconds 3; $p = Get-CimInstance Win32_Process -Filter "Name='${path.basename(HIVE_EXE)}'" | Where-Object { $_.ExecutablePath -eq '${HIVE_EXE.replace(/'/g, "''")}' }; foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; @($p).Count`)
  return Number(out) || 0
}

async function launch() {
  const t0 = Date.now()
  app = await _electron.launch({ executablePath: HIVE_EXE, args: [], timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  page.on('pageerror', e => { (res.facts.pageErrors ||= []).push(String(e.message).slice(0, 300)) })
  await page.waitForSelector('.app .workbench', { timeout: 90_000 })
  res.facts.launchMs = Date.now() - t0
  // Ready once every provider check has finished (as Hive's e2e lib does).
  await until(async () => Object.values(await inv('provider:info')).every(i => !i.checking), 60_000)
  res.facts.readyMs = Date.now() - t0
}

/** The window has painted what it has and runs no finite animation (a dialog's or a theme's fade; a spinner's never ends), within 5 s. */
const painted = () => until(() => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)))))), 5000)

async function shot(name) {
  const file = `${prefix}-${name}.png`
  await painted()
  await page.screenshot({ path: path.join(OUT, file) })
  res.shots.push(file)
  save()
}

/** Sets the theme, and waits until the window shows it and Hive has saved it (it saves 300 ms after a change). */
async function theme(t) {
  await inv('settings:update', { appearance: { theme: t } })
  await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === t && readConfig()?.settings?.appearance?.theme === t, 5000)
}

async function api(route) {
  const token = JSON.parse(fs.readFileSync(path.join(PROFILE, 'agent-api.json'), 'utf8')).token
  const port = readConfig()?.settings?.agentApi?.port || 47821
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
  return r.json()
}

async function providerSetup() {
  const dialog = page.locator('.dialog', { hasText: 'Provider Setup' })
  if (!(await dialog.count())) {
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+P')
    // Typed only once the palette's box has the focus, and Enter only once Provider Setup's command is the one chosen.
    const typing = await until(async () => page.evaluate(() => !!document.activeElement?.closest('.palette')), 10_000)
    if (typing) {
      await page.keyboard.type('Provider Setup')
      if (await until(async () => (await page.locator('.palette-item.active[data-command="help.agentSetup"]').count()) === 1, 10_000)) await page.keyboard.press('Enter')
    }
  }
  return (await until(async () => (await dialog.count()) === 1, 10_000)) ? dialog : null
}

/** HKCU's Run values that start Hive.exe or Combwork.exe (Launch at login): [{ name, command }]. */
function runValues() {
  try {
    const out = ps("$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if (Test-Path $k) { $i = Get-Item $k; @($i.Property | ForEach-Object { [ordered]@{ name = $_; command = [string]$i.GetValue($_) } } | Where-Object { $_.command -match 'Hive\\.exe|Combwork\\.exe' }) | ConvertTo-Json -Compress }")
    if (!out) return []
    const v = JSON.parse(out)
    return Array.isArray(v) ? v : [v]
  } catch {
    return []
  }
}

const bodyText = () => page.evaluate(() => document.body.innerText)
const statusWarnings = () => page.$$eval('.statusbar .status-item.warn', els => els.map(e => (e.innerText || e.getAttribute('title') || '').trim()))

const steps = {
  async 'first-run'() {
    await launch()
    const health = await api('/v1/health')
    res.facts.version = health.version
    res.facts.profileExists = fs.existsSync(PROFILE)
    // The app's own name (productName: HI-2458's), as the start screen should show it.
    res.facts.appName = await app.evaluate(({ app: a }) => a.getName())
    check('1.start-screen', `First launch shows the start screen ("${res.facts.appName}")`, (await page.locator('.welcome h1', { hasText: res.facts.appName }).count()) > 0, (await bodyText()).slice(0, 400))
    check('1.profile', `The profile is ${PROFILE}`, fs.existsSync(path.join(PROFILE, 'config.json')), PROFILE)
    const text = await bodyText()
    const banner = (await page.locator('.providers-banner').allInnerTexts()).join(' | ')
    res.facts.banner = banner
    res.facts.statusWarnings = await statusWarnings()
    check('2.banner', 'No coding agent is on: the banner says so and offers "Choose providers"', /No coding agents are turned on/.test(banner) && /Choose providers/.test(banner), banner)
    check('2.no-claude-warning', 'No "Claude Code is not installed" warning on a machine without CLIs', !/Claude Code is not installed/.test(text) && !res.facts.statusWarnings.some(w => /Claude/.test(w)), JSON.stringify({ statusWarnings: res.facts.statusWarnings }))
    res.facts.gitMissing = res.facts.statusWarnings.some(w => /^Git\b/.test(w)) || /Git isn't installed/.test(text)
    await shot('start-dark')
    const providers = await api('/v1/providers')
    res.facts.providers = providers
    const list = providers.providers || providers
    check('2.api-providers', 'Agent API: all three providers known, none on, none installed', Array.isArray(list) && list.length === 3 && list.every(p => !p.enabled && !p.installed), JSON.stringify(list))

    const dialog = await providerSetup()
    check('2.agent-setup-opens', 'Provider Setup opens', !!dialog, 'no dialog')
    if (dialog) {
      const tabs = (await dialog.locator('.setup-tab').allInnerTexts()).map(t => t.trim())
      res.facts.setupTabs = tabs
      check('2.agent-setup-three', 'Provider Setup offers all three: Claude Code, Codex, GitHub Copilot', ['Claude Code', 'Codex', 'GitHub Copilot'].every(n => tabs.some(t => t.startsWith(n))), JSON.stringify(tabs))
      res.facts.gitRow = await dialog.locator('[data-git]').getAttribute('data-git').catch(() => null)
      await shot('agent-setup-dark')
      await theme('light')
      await shot('agent-setup-light')
      await page.keyboard.press('Escape')
      await shot('start-light')
      await theme('dark')
    }
  },

  async 'cli-appears'() {
    await launch()
    const pid = app.process().pid
    // Turn Claude Code on, as a user does: the banner's "Choose providers", then its switch.
    await page.locator('.providers-banner button', { hasText: 'Choose providers' }).click({ timeout: 10_000 }).catch(() => {})
    const sw = page.locator('[role="switch"][aria-label="Use Claude Code"]')
    await sw.click({ timeout: 10_000 })
    const on = await until(async () => { const i = (await inv('provider:info'))['claude-code']; return i && !i.checking && i }, 30_000)
    res.facts.before = on
    check('3.on-not-found', 'Claude Code turned on, not found yet', on && !on.found, JSON.stringify(on))
    const banner = (await page.locator('.providers-banner').allInnerTexts()).join(' | ')
    check('3.banner-none-installed', 'The banner now says no CLI is installed and offers Provider Setup', /No coding agent CLI is installed/.test(banner) && /Provider Setup/.test(banner), banner)
    const dialog = await providerSetup()
    // Without the dialog the rest still runs and reports, each check failing with this reason rather than a crash.
    const NO_DIALOG = 'no Provider Setup dialog (the command palette found no "Provider Setup" command, or it opened nothing)'
    const dialogText = async () => (dialog ? dialog.innerText() : NO_DIALOG)
    if (dialog) await dialog.locator('.setup-tab', { hasText: 'Claude Code' }).click()
    check('3.setup-not-installed', 'Provider Setup says "Claude Code is not installed"', dialog && /Claude Code is not installed/.test(await dialogText()), await dialogText())
    await shot('missing-dark')

    // The stand-in installer: the e2e fake Claude Code copied into the user's programs, on the user PATH (registry).
    res.facts.install = ps('& C:\\tools\\hive-tests\\sandbox\\inside\\fake-claude-install.ps1')
    const hivePath = await app.evaluate(() => process.env.PATH || process.env.Path || '')
    check('3.user-path', 'The new folder is on the user PATH, not on Hive\'s own PATH yet', !hivePath.toLowerCase().includes('fakeclaude'), hivePath.slice(0, 300))
    if (dialog) await dialog.locator('button', { hasText: 'Check again' }).click()
    const found = dialog && await until(async () => { const i = (await inv('provider:info'))['claude-code']; return i && !i.checking && i.found && i }, 30_000)
    res.facts.after = found || (await inv('provider:info'))['claude-code']
    check('3.check-again-finds', '"Check again" finds it, without restarting Hive', found && found.source === 'PATH' && found.version === '2.1.999' && /claude\.cmd$/i.test(found.path || '') && app.process().pid === pid, dialog ? JSON.stringify(res.facts.after) : `${NO_DIALOG}, so "Check again" was never pressed; ${JSON.stringify(res.facts.after)}`)
    check('3.setup-found', 'Provider Setup shows "Claude Code 2.1.999 — found via …"', dialog && /Claude Code 2\.1\.999 — found via/.test(await dialogText()), await dialogText())
    await shot('found-dark')
    await theme('light')
    await shot('found-light')
    await theme('dark')
    await page.keyboard.press('Escape')
    const providers = await api('/v1/providers')
    const claude = (providers.providers || providers).find(p => p.id === 'claude-code')
    check('3.api-installed', 'Agent API: Claude Code on and installed, 2.1.999', claude && claude.enabled && claude.installed && claude.version === '2.1.999', JSON.stringify(claude))
    const banner2 = (await page.locator('.providers-banner').allInnerTexts()).join(' | ')
    check('3.banner-gone', 'No provider banner any more', !banner2, banner2)
    await shot('ready-dark')
  },

  // Scenario 6 (for the fresh-install comparison, no model): what a fresh Hive makes of a new workspace.
  async workspace() {
    await launch()
    const ws = path.join(process.env.USERPROFILE, 'Workspaces', 'Fresh')
    fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'demo', 'README.md'), '# demo\n')
    await inv('workspace:open', ws)
    const opened = await until(async () => (await page.locator('.welcome').count()) === 0 && fs.existsSync(path.join(ws, '.combwork')), 30_000)
    check('6.workspace-opens', 'A new workspace opens (an empty folder with one project folder)', opened, 'still on the welcome screen')
    const tree = (dir, depth) => {
      if (!fs.existsSync(dir)) return null
      return fs.readdirSync(dir, { withFileTypes: true }).map(e => (e.isDirectory() ? { [e.name]: depth > 1 ? tree(path.join(dir, e.name), depth - 1) : '(folder)' } : e.name))
    }
    // Recorded once Hive has set the workspace up: its status names it with its Hive skills, which it replies with only
    // once the open has brought the bundled skills and modes up to date. Not set up within the bound: the check fails,
    // and what is there is kept apart (hiveNotSetUp), never recorded as the workspace's.
    const status = await workspaceSetUp(() => api('/v1/status'), ws)
    const now = tree(path.join(ws, '.combwork'), 3)
    if (status) res.facts.hive = now
    else res.facts.hiveNotSetUp = now
    res.facts.projectHive = tree(path.join(ws, 'demo', '.combwork'), 1)
    try { res.facts.workspaceJson = JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'workspace.json'), 'utf8')) } catch { /* recorded as missing */ }
    check('6.hive-folder', 'Hive creates the workspace\'s .combwork folder and sets it up (its status lists its Hive skills)', status && Array.isArray(res.facts.hive), status ? 'no .combwork folder' : `Hive didn't say the workspace was set up within 60 s (GET /v1/status): ${JSON.stringify(now).slice(0, 300)}`)
    res.facts.status = status && { workspace: status.workspace, workspaces: status.workspaces, providers: status.providers && Object.keys(status.providers) }
    res.facts.projects = await api('/v1/projects').catch(e => ({ error: String(e) }))
    res.facts.views = {}
    await shot('workspace')
    let shown = 0
    for (const view of VIEWS) {
      const { name, slug } = view
      try {
        await page.getByRole('button', { name, exact: true }).first().click({ timeout: 5000 })
        // Read once the view shows its loaded data (ready.cjs VIEWS); not loaded within the bound, it isn't counted.
        if (!(await viewReady(view, sel => page.locator(sel).count()))) throw new Error(`the ${name} view didn't show its loaded content within 20 s (${view.ready.join(', ')})`)
        res.facts.views[name] = (await page.evaluate(() => (document.querySelector('.workbench') || document.body).innerText)).slice(0, 1500)
        await shot(slug)
        shown++
      } catch (e) {
        res.facts.views[name] = `not shown: ${String(e.message).slice(0, 300)}`
      }
    }
    check('6.views', `The workspace's views open with their content (${VIEWS.map(v => v.name).join(', ')})`, shown === VIEWS.length, JSON.stringify(res.facts.views).slice(0, 600))
  },

  async mark() {
    await launch()
    res.facts.version = (await api('/v1/health')).version
    // Launch at login on too (HI-2460): 1.0 registers its Hive.exe, which the upgrade replaces with Combwork.exe.
    await inv('settings:update', { general: { userName: MARK.userName, launchAtLogin: true }, appearance: { theme: MARK.theme } })
    const saved = await until(async () => { const c = readConfig(); return c?.settings?.general?.userName === MARK.userName && c.settings.general.launchAtLogin === true && c.settings.appearance?.theme === MARK.theme && c }, 10_000)
    check('4.settings-saved', `Before the upgrade: user name "${MARK.userName}", the ${MARK.theme} theme and Launch at login saved`, saved, JSON.stringify(readConfig()?.settings?.general))
    // Something in the local profile folder (where accounts live), for the upgrade to carry across.
    const local = path.join(process.env.LOCALAPPDATA, 'Hive')
    fs.mkdirSync(local, { recursive: true })
    fs.writeFileSync(path.join(local, LOCAL_MARK), 'kept across the upgrade')
    fs.mkdirSync(path.join(local, TRUST_HOME), { recursive: true })
    fs.writeFileSync(path.join(local, TRUST_HOME, '.claude.json'), JSON.stringify(TRUST_JSON, null, 2))
    res.facts.runBefore = runValues()
    check('4.login-registered', 'Before the upgrade: Launch at login starts Hive.exe', res.facts.runBefore.some((v) => /\\Hive\.exe/i.test(v.command)), JSON.stringify(res.facts.runBefore))
    // A workspace the release before makes in .hive (HI-2462, HI-2506): a project and a card naming a note by its path,
    // for the upgrade's first open to move to .combwork.
    fs.mkdirSync(path.join(KEPT_WS, 'demo'), { recursive: true })
    fs.writeFileSync(path.join(KEPT_WS, 'demo', 'README.md'), '# demo\n')
    await inv('workspace:open', KEPT_WS)
    const made = await until(async () => fs.existsSync(path.join(KEPT_WS, '.hive', 'hive.db')) && fs.existsSync(path.join(KEPT_WS, 'demo', '.hive', 'project.json')), 30_000)
    let card = null
    if (made) card = await inv('tasks:create', { title: KEPT_CARD, project: 'demo', description: `The plan: ${path.join(KEPT_WS, '.hive', 'shared', 'plan.md')}` }).catch((e) => ({ error: String(e) }))
    res.facts.keptWorkspace = { made: !!made, card }
    check('4.workspace-made', 'Before the upgrade: a workspace with a project and a card, in .hive', !!made && typeof card?.number === 'number', JSON.stringify(res.facts.keptWorkspace))
    await shot('before-upgrade')
  },

  // Scenario 8 (HI-2460): a Windows notification from the installed app, under its own app ID: Windows records an app
  // that has notified under Notifications\Settings\<its AUMID>.
  async notify() {
    await launch()
    const aumid = 'it.surmise.combwork'
    res.facts.exe = HIVE_EXE
    res.facts.shown = await app.evaluate(({ Notification }) => {
      if (!Notification.isSupported()) return false
      // Kept on screen until dismissed, for the desktop screenshot the host takes next (its banner shows the app's name).
      new Notification({ title: 'Combwork check', body: 'A notification from the installed app', timeoutType: 'never' }).show()
      return true
    })
    const key = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${aumid}`
    const known = await until(async () => ps(`Test-Path '${key}'`) === 'True', 20_000)
    // Its scenario: the prefix's (s4-notify → 4), else 8.
    const sc = /^s(\d+)/.exec(prefix)?.[1] || '8'
    check(`${sc}.notification`, `A notification shows under the app ID ${aumid} (Windows lists it in Notifications)`, res.facts.shown && known, `shown ${res.facts.shown}; ${key} ${known ? 'there' : 'missing'}`)
    await shot('notified')
  },

  async 'after-upgrade'() {
    res.facts.closedForceRun = closeRunningHive()
    await launch()
    res.facts.version = (await api('/v1/health')).version
    const c = readConfig()
    res.facts.settings = { userName: c?.settings?.general?.userName, theme: c?.settings?.appearance?.theme, lastRunVersion: c?.lastRunVersion }
    check('4.settings-kept', 'Settings kept: user name and theme', res.facts.settings.userName === MARK.userName && res.facts.settings.theme === MARK.theme, JSON.stringify(res.facts.settings))
    check('4.theme-applied', 'The window is in the kept theme', (await page.evaluate(() => document.documentElement.dataset.theme)) === MARK.theme, 'theme not applied')
    // HI-2460: the app that runs is Combwork's, from its moved profile folders, with the local data and the installer's record.
    res.facts.exe = HIVE_EXE
    res.facts.profile = PROFILE
    check('4.combwork-runs', 'Combwork.exe runs after the upgrade, from %APPDATA%\\Combwork', HIVE_EXE === COMBWORK_EXE && PROFILE === path.join(process.env.APPDATA, 'Combwork'), `${HIVE_EXE}, ${PROFILE}`)
    const localNew = path.join(process.env.LOCALAPPDATA, 'Combwork')
    check('4.local-moved', 'The local folder moved with its data: %LOCALAPPDATA%\\Combwork, no %LOCALAPPDATA%\\Hive', fs.existsSync(path.join(localNew, LOCAL_MARK)) && !fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Hive')), fs.readdirSync(process.env.LOCALAPPDATA).filter((n) => /hive|combwork/i.test(n)).join(', '))
    let trustAfter = null
    try { trustAfter = JSON.parse(fs.readFileSync(path.join(localNew, TRUST_HOME, '.claude.json'), 'utf8')) } catch { /* below */ }
    const trustEntries = (j) => Object.entries(j?.projects ?? {}).map(([k, v]) => [k, v?.hasTrustDialogAccepted])
    check('4.trust-kept', "A connection home's Claude Code folder trust moved as it was: trusted stays trusted, untrusted stays untrusted, nothing added", JSON.stringify(trustEntries(trustAfter)) === JSON.stringify(trustEntries(TRUST_JSON)), JSON.stringify(trustAfter))
    check('4.roaming-moved', 'The roaming folder moved: no %APPDATA%\\Hive left', !fs.existsSync(path.join(process.env.APPDATA, 'Hive')), fs.readdirSync(process.env.APPDATA).filter((n) => /hive|combwork/i.test(n)).join(', '))
    let rec = null
    try { rec = JSON.parse(fs.readFileSync(path.join(localNew, 'profile-move.json'), 'utf8')) } catch { /* below */ }
    res.facts.record = rec
    check('4.record', "The installer's record arrived with the local folder (v 1, by installer)", rec?.v === 1 && rec.by === 'installer' && /\\Hive$/i.test(String(rec.from)), JSON.stringify(rec))
    // Its Launch at login: written for Combwork.exe at start (loginItem.ts), Hive Desktop's removed by the installer.
    const runs = await until(async () => { const v = runValues(); return v.some((x) => /\\Combwork\.exe/i.test(x.command)) && v }, 15_000)
    res.facts.runAfter = runs || runValues()
    check('4.login-moved', 'Launch at login starts Combwork.exe, and nothing starts Hive.exe', !!runs && !runs.some((x) => /\\Hive\.exe/i.test(x.command)), JSON.stringify(res.facts.runAfter))
    const fallback = await page.locator('.toast', { hasText: "Hive Desktop's data folders" }).count()
    check('4.no-fallback', 'No notice that Hive runs from its old folders', fallback === 0, `${fallback} such notice(s)`)
    // The workspace made before the upgrade, opened (again, or restored at start): its .hive folders moved to .combwork,
    // its board and the card's path with them (HI-2462, HI-2506).
    await inv('workspace:open', KEPT_WS).catch(() => undefined)
    const movedNow = () => fs.existsSync(path.join(KEPT_WS, '.combwork', 'hive.db')) && !fs.existsSync(path.join(KEPT_WS, '.hive')) && fs.existsSync(path.join(KEPT_WS, 'demo', '.combwork', 'project.json')) && !fs.existsSync(path.join(KEPT_WS, 'demo', '.hive'))
    const moved = await until(async () => movedNow(), 30_000)
    res.facts.keptWorkspaceAfter = fs.existsSync(KEPT_WS) ? fs.readdirSync(KEPT_WS) : null
    check('4.workspace-moved', "The workspace from before opens with its .hive folders moved to .combwork (the workspace's and the project's)", !!moved, JSON.stringify(res.facts.keptWorkspaceAfter))
    const cards = await inv('tasks:list').catch((e) => ({ error: String(e) }))
    const card = Array.isArray(cards) ? cards.find((x) => x.title === KEPT_CARD) : null
    res.facts.keptCard = card ? { number: card.number, description: card.description } : cards
    check('4.workspace-card', 'Its card is on the board, its path now into .combwork', !!card && card.description === `The plan: ${path.join(KEPT_WS, '.combwork', 'shared', 'plan.md')}`, JSON.stringify(res.facts.keptCard))
    await shot('after-upgrade-light')
    await theme('dark')
    await shot('after-upgrade-dark')
  }
}

;(async () => {
  try {
    if (!steps[step]) throw new Error(`unknown step ${step}`)
    if (step !== 'after-upgrade') res.facts.closedBefore = closeRunningHive()
    await steps[step]()
    res.completed = true
  } catch (e) {
    res.error = String(e.stack || e).slice(0, 2000)
    check(`${prefix}.error`, `${step}: no error`, false, res.error)
    if (page) await shot('error').catch(() => {})
    process.exitCode = 1
  } finally {
    if (app) {
      // Every settings change above waited for Hive to save it (mark, theme), so it can close now.
      await app.close().catch(e => { res.closeError = String(e) })
    }
    save()
  }
})()
