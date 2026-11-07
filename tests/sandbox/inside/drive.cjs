/**
 * Runs inside the Sandbox, as the user, with the host's Node, Combwork's own playwright-core and Combwork's tests folder (this
 * file's, tests\sandbox\inside, is in it) mapped read-only by the Sandbox checks (tests\sandbox\checks.cjs):
 *   C:\tools\node\node.exe C:\tools\combwork-tests\sandbox\inside\drive.cjs <step> <prefix> [<era>]
 * <era> (mark and after-upgrade): what the release before the upgrade left, 1.0, rc or combwork (checks.cjs previousEra).
 * Drives the installed app (Combwork, or the 1.0 app before an upgrade, and its real profile: see CW_EXE and PROFILE below) with Playwright's
 * _electron, as Combwork's e2e suites do, and writes C:\out\<prefix>.json ({ step, checks: [{ id, scenario, name, ok, detail }],
 * facts, shots, completed }) and window PNGs C:\out\<prefix>-<name>.png. completed is true only once the whole step ran
 * (the file is saved as it goes, so an interrupted step leaves a record without it). Network off, fake CLIs only.
 * Steps:
 *   first-run     scenarios 1 and 2: the first screen, no-CLI banners, Provider Setup's three providers, both themes
 *   cli-appears   scenario 3: Claude Code turned on, a stand-in installer puts the e2e fake on the user PATH, and
 *                 Provider Setup's "Check again" finds it without restarting Combwork
 *   workspace     scenario 6: a new workspace in the fresh install (its .combwork, views and status), for the fresh-install comparison
 *   mark          scenario 4, before the upgrade: change two settings (user name, theme), and two Advanced
 *                 overrides under 1.0's old ids (Combwork's own and a workspace's own, HI-2518). From 1.1 on
 *                 (HI-2727): a real workspace instead, through 1.1's own IPC and Agent API: a git project on a
 *                 slots preset, two cards, a connection, Advanced overrides under cw.*, and a lane lent a slot
 *   after-upgrade scenario 4, after it: those settings kept, the Advanced overrides under cw.* (an old id refused,
 *                 naming the new one), the version, a screenshot. From 1.1 on: everything mark seeded, by its
 *                 ids, as it was (nothing renamed)
 *   clean         scenario 9 (HI-2592): a new user's first session on a clean install: first run, Claude Code on and an
 *                 account (the fake), a workspace with a git project, an agent started briefly (its `set` kept), a card,
 *                 Settings, Copy Diagnostics, Export Board, quit. Keeps what the window showed and what it copied for
 *                 clean-scan.cjs, which then searches it all for the old name.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { _electron } = require(process.env.PW_CORE || 'C:\\tools\\playwright')

const [step, prefix] = process.argv.slice(2)
const OUT = 'C:\\out'
// old-name: begin drive-inputs
// 1.0's names, as the release before leaves them for the upgrade: the app's (its install and profile folders) and its
// exe; the workspace's folder, its board and log files, its skill copies' marker and its board copies' prefix; the
// advanced ids and stored values it writes; its log's start line; the name in any case, for what must be gone.
const OLD_NAME = 'Hive'
const OLD_EXE = 'Hive.exe'
const OLD_DIR = '.hive'
const OLD_DB = 'hive.db'
const OLD_LOG = 'hive.log'
const OLD_COPY_MARKER = '.hive-copy'
const OLD_BACKUP_PREFIX = 'hive-'
const OLD_ADV = { app: 'hive.mcp.replySeconds', ws: 'hive.progress.lanesShown' }
const OLD_GIT_OPTIONS = { finish: 'hiveMerges', commitMessage: 'hive' }
const OLD_ACTOR = 'hive'
const OLD_START_LINE = /\b(Hive|Combwork) (\S+) starting/g
const OLD_NAME_RE = /hive/i
// The notice an RC showed when it ran from 1.0's folders (removed by HI-2594): a 1.1 must never show it.
const OLD_FALLBACK_NOTICE = "Hive Desktop's data folders"
// 1.0's preload bridge (window.hive; HI-2588 renamed it window.combwork), which the mark step drives before the upgrade (HI-2645).
const OLD_BRIDGE = 'hive'
// old-name: end drive-inputs
// The installed app (HI-2460): Combwork's when it is installed, else the 1.0 app's (before an upgrade). Its
// profile: Combwork's folder when it is there, else 1.0's own (before the upgrade moves it).
const COMBWORK_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'Combwork', 'Combwork.exe')
const OLD_APP_EXE = path.join(process.env.LOCALAPPDATA, 'Programs', OLD_NAME, OLD_EXE)
const CW_EXE = fs.existsSync(COMBWORK_EXE) ? COMBWORK_EXE : OLD_APP_EXE
const PROFILE = [path.join(process.env.APPDATA, 'Combwork'), path.join(process.env.APPDATA, OLD_NAME)].find((p) => fs.existsSync(p)) ?? path.join(process.env.APPDATA, CW_EXE === COMBWORK_EXE ? 'Combwork' : OLD_NAME)
/** Whether a command starts 1.0's exe (its install folder's). */
const startsOld = (command) => String(command).toLowerCase().includes(`\\${OLD_EXE}`.toLowerCase())
// A file the upgrade must carry across in the local profile folder (accounts live there), written before it.
const LOCAL_MARK = 'sandbox-mark.txt'
// A connection's Claude Code home in the local folder (HI-2520): its folder trust must arrive as it was, nothing more
// trusted. One folder trusted, one answered no; a third never listed must stay unlisted.
const TRUST_HOME = path.join('accounts', 'a-sandbox')
const TRUST_JSON = { hasCompletedOnboarding: true, projects: { 'C:/Sandbox/trusted': { hasTrustDialogAccepted: true }, 'C:/Sandbox/untrusted': { hasTrustDialogAccepted: false } } }
const MARK = { userName: 'Sandbox Check', theme: 'light' }
// The providers Combwork knows, by their descriptors' ids (src/shared/providers.ts PROVIDERS; a unit test holds them equal).
const PROVIDER_IDS = ['claude-code', 'codex', 'copilot', 'antigravity']
// Scenario 4's workspace, made before the upgrade and opened after it (HI-2506), and its card.
const KEPT_WS = path.join(process.env.USERPROFILE, 'Workspaces', 'Kept')
const KEPT_CARD = 'Made before the upgrade'
// Scenario 4's advanced overrides (HI-2518): set under the release before's old ids, read back under cw.* after.
const ADV = { app: { old: OLD_ADV.app, now: 'cw.mcp.replySeconds', value: 600 }, ws: { old: OLD_ADV.ws, now: 'cw.progress.lanesShown', value: 6 } }
// What the release before the upgrade left (HI-2727; checks.cjs previousEra passes it): '1.0' (its names, for the names
// upgrade and the profile move), 'rc' (a 1.1 release candidate, already partly converted: its profile, .combwork and
// cw.* ids; HI-2587, scenario 10, prefix s10), 'combwork' (1.1 and later: Combwork's names, the data carried over as it is).
const ERA = process.argv[4] || ((prefix || '').startsWith('s10') ? 'rc' : '1.0')
const FROM_RC = ERA === 'rc'
const FROM_COMBWORK = ERA === 'combwork'
// The workspace's folder as the release before made it: 1.0's own, else .combwork; its board and its log likewise.
const TREE_BEFORE = ERA === '1.0' ? OLD_DIR : '.combwork'
const DB_BEFORE = FROM_COMBWORK ? 'combwork.db' : OLD_DB
const LOG_BEFORE = FROM_COMBWORK ? 'combwork.log' : OLD_LOG
// From 1.1 on (HI-2727), a real workspace: its project a git repository on the Pair (agent merges) preset, so a lane's
// start lends its builder a slot (a worktree in Kept.worktrees); two cards, one labelled, commented and linked to the
// other; the agent the lane is over; a Claude Code connection (the fake). Git is this machine's, mapped at C:\tools\git.
const GIT_CMD = 'C:\\tools\\git\\cmd'
const FAKE_BIN = path.join(process.env.LOCALAPPDATA, 'FakeClaude', 'bin')
const KEPT_PROJECT = path.join(KEPT_WS, 'demo')
const SEED = { connection: 'Sandbox', builder: 'Builder', second: 'Linked before the upgrade', label: 'kept', comment: 'A comment made before the upgrade', lane: 'Kept lane', preset: 'pairAgent' }
// What mark seeded, by id, for after-upgrade to read back (C:\out stays across the upgrade): mark's own record.
const markRecord = () => readJson(path.join(OUT, `${String(prefix).replace(/-after$/, '-mark')}.json`))
// A skill copy the release before made in the project (its marker, HI-2587), for the upgrade to rename.
const COPY = path.join('demo', '.agents', 'skills', 'cw-sandbox-check')
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const res = { step, prefix, at: new Date().toISOString(), checks: [], facts: {}, shots: [] }
const save = () => fs.writeFileSync(path.join(OUT, `${prefix}.json`), JSON.stringify(res, null, 2))
// Each check has a stable id ("<scenario>.<what>"): the host's report requires the ids each step must produce.
const check = (id, name, ok, detail) => { res.checks.push({ id, scenario: Number(String(id).split('.')[0]) || 0, name, ok: !!ok, detail: ok ? undefined : String(detail ?? '').slice(0, 1500) }); save() }
// When what it reads is ready: conditions Combwork says are met, each bounded (ready.cjs, unit-tested in Combwork's npm test).
const { until, workspaceSetUp, VIEWS, viewReady, pickBridge, releasesStarted } = require(path.join(__dirname, 'ready.cjs'))
// The names upgrade's record's version (src/main/nameUpgrade.ts NAMES_VERSION; a unit test holds them equal).
const NAMES_VERSION = 4
const ps = cmd => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60_000 }).trim()
const readConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(PROFILE, 'config.json'), 'utf8')) } catch { return null } }

let app
let page
// The preload bridge the step talks to (HI-2645): the new app's window.combwork. Only mark drives the release before
// (1.0, or an RC from before HI-2588 in scenario 10), so only it may use that release's own bridge.
const BRIDGES = step === 'mark' ? ['combwork', OLD_BRIDGE] : ['combwork']
let bridge
const inv = (channel, ...args) => page.evaluate(([b, c, a]) => window[b].invoke(c, ...a), [bridge, channel, args])

/** Combwork instances already running from the install folder (the installer's --force-run starts one): closed by PID. */
function closeRunningApp() {
  const out = ps(`$p = Get-CimInstance Win32_Process -Filter "Name='${path.basename(CW_EXE)}'" | Where-Object { $_.ExecutablePath -eq '${CW_EXE.replace(/'/g, "''")}' }; foreach ($x in $p) { $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue; if ($g -and $g.MainWindowHandle -ne 0) { [void]$g.CloseMainWindow() } }; Start-Sleep -Seconds 3; $p = Get-CimInstance Win32_Process -Filter "Name='${path.basename(CW_EXE)}'" | Where-Object { $_.ExecutablePath -eq '${CW_EXE.replace(/'/g, "''")}' }; foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; @($p).Count`)
  return Number(out) || 0
}

async function launch(opts = {}) {
  const t0 = Date.now()
  app = await _electron.launch({ executablePath: CW_EXE, args: [], timeout: 90_000, ...opts })
  page = await app.firstWindow({ timeout: 90_000 })
  page.on('pageerror', e => { (res.facts.pageErrors ||= []).push(String(e.message).slice(0, 300)) })
  await page.waitForSelector('.app .workbench', { timeout: 90_000 })
  bridge = pickBridge(BRIDGES, await page.evaluate((names) => names.filter((n) => typeof window[n]?.invoke === 'function'), BRIDGES))
  res.facts.bridge = bridge
  if (!bridge) throw new Error(`the window has no preload bridge the ${step} step uses (window.${BRIDGES.join(' or window.')})`)
  res.facts.launchMs = Date.now() - t0
  // Ready once every provider check has finished (as Combwork's e2e lib does).
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

/** Sets the theme, and waits until the window shows it and Combwork has saved it (it saves 300 ms after a change). */
async function theme(t) {
  await inv('settings:update', { appearance: { theme: t } })
  await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === t && readConfig()?.settings?.appearance?.theme === t, 5000)
}

/** The Agent API with the user's token: GET by default, or `method` with a JSON `body`. */
async function api(route, method = 'GET', body) {
  const token = JSON.parse(fs.readFileSync(path.join(PROFILE, 'agent-api.json'), 'utf8')).token
  const port = readConfig()?.settings?.agentApi?.port || 47821
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) })
  return r.json()
}

/** A folder put on the user PATH (the registry's, as an installer does), for what starts later outside this script. */
const onUserPath = (dir) => ps(`$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not (($p -split ';') -contains '${dir}')) { [Environment]::SetEnvironmentVariable('Path', ((@($p, '${dir}') | Where-Object { $_ }) -join ';'), 'User') }`)

/**
 * The environment Combwork starts with, as a user's would be: this script's, less what the checks themselves put in it
 * (the mapped tests folder's path), which no user has, with Git and the fake Claude Code on its PATH. `dropped`: what was left out.
 */
function userEnv() {
  const env = {}
  const dropped = []
  for (const [k, v] of Object.entries(process.env)) {
    if (/^path$/i.test(k)) {
      const parts = String(v).split(';').filter(Boolean)
      dropped.push(...parts.filter((x) => OLD_NAME_RE.test(x)))
      env[k] = [...parts.filter((x) => !OLD_NAME_RE.test(x)), GIT_CMD, FAKE_BIN].join(';')
    } else if (OLD_NAME_RE.test(k) || OLD_NAME_RE.test(String(v))) dropped.push(k)
    else env[k] = v
  }
  return { env, dropped }
}

/** Git in the seeded project, as this machine's mapped Git runs it; its output, or why it failed. */
function git(cwd, ...args) {
  try { return { ok: true, out: execFileSync(path.join(GIT_CMD, 'git.exe'), ['-c', 'user.name=Sandbox Check', '-c', 'user.email=sandbox-check@example.invalid', ...args], { cwd, encoding: 'utf8', timeout: 60_000 }).trim() } } catch (e) { return { ok: false, out: String(e.message).slice(0, 400) } }
}

/** The worktrees git lists for the seeded project: their folders, lower-cased, with \ separators. */
const worktreesOf = (cwd) => (git(cwd, 'worktree', 'list', '--porcelain').out || '').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)).toLowerCase())

/** A card as the Agent API reads it, as much of it as an upgrade must keep (HI-2727). */
async function cardView(n) {
  const t = await api(`/v1/tasks/${n}`).catch((e) => ({ error: String(e) }))
  if (!t || t.error || t.number !== n) return { error: t?.error ?? `no card ${n}` }
  return { number: t.number, title: t.title, description: t.description, column: t.column, kind: t.kind, labels: [...(t.labels ?? [])].sort(), links: [...(t.links ?? [])].map((l) => (typeof l === 'object' ? l.number : l)).sort(), comments: (t.comments ?? []).map((c) => (typeof c === 'string' ? c : (c.text ?? c.body ?? ''))) }
}

/** The seeded lane as the Agent API lists it: its id, builder, cards, state and slot. */
async function laneView(id) {
  const list = await api('/v1/lanes?project=demo&all=true').catch((e) => ({ error: String(e) }))
  const l = Array.isArray(list) ? list.find((x) => x.id === id) : null
  return l ? { id: l.id, name: l.name, builder: l.builder?.id, cards: (l.cards ?? []).map((c) => (typeof c === 'object' ? c.number : c)), state: l.state, slot: l.slot ?? null } : { error: Array.isArray(list) ? `no lane ${id} in ${JSON.stringify(list.map((x) => x.id))}` : JSON.stringify(list).slice(0, 300) }
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

/** HKCU's Run values that start 1.0's exe or Combwork.exe (Launch at login): [{ name, command }]. */
function runValues() {
  try {
    const out = ps("$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if (Test-Path $k) { $i = Get-Item $k; @($i.Property | ForEach-Object { [ordered]@{ name = $_; command = [string]$i.GetValue($_) } } | Where-Object { $_.command -match '" + OLD_EXE.replace('.', '\\.') + "|Combwork\\.exe' }) | ConvertTo-Json -Compress }")
    if (!out) return []
    const v = JSON.parse(out)
    return Array.isArray(v) ? v : [v]
  } catch {
    return []
  }
}

/**
 * Runs a command from the palette as a user does: Ctrl+Shift+P, its name typed, Enter only once the command `id` is the
 * one chosen. False when the palette or the command didn't come.
 */
async function paletteCommand(id, typed) {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Shift+P')
  if (!(await until(async () => page.evaluate(() => !!document.activeElement?.closest('.palette')), 10_000))) return false
  await page.keyboard.type(typed)
  if (!(await until(async () => (await page.locator(`.palette-item.active[data-command="${id}"]`).count()) === 1, 10_000))) return false
  await page.keyboard.press('Enter')
  return true
}

/** All the text the window shows a user: its title, the page's text, and the titles, labels and placeholders on hover. */
const windowText = async () => {
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).join(' | ')).catch((e) => `(title unread: ${e.message})`)
  const text = await page.evaluate(() => [document.title, document.body.innerText, ...[...document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')].map((e) => ['title', 'aria-label', 'placeholder', 'alt'].map((a) => e.getAttribute(a)).filter(Boolean).join(' | '))].join('\n'))
  return `${title}\n${text}`
}

const bodyText = () => page.evaluate(() => document.body.innerText)
const statusWarnings = () => page.$$eval('.statusbar .status-item.warn', els => els.map(e => (e.innerText || e.getAttribute('title') || '').trim()))

/** The project's kept Git options in the kept workspace's project.json, in the folder named (the release before's or .combwork). */
const keptGitOptions = (tree) => readJson(path.join(KEPT_WS, 'demo', tree, 'project.json'))?.workflow?.kept?.git?.options ?? null

/**
 * Mark's end: its screenshot, then the release before quit, then the project's Git workflow options as that release
 * writes them (its merges, its commit message; HI-2598), for the upgrade to convert to Combwork's. Written only once it
 * has quit (HI-2645): a running app saves its project.json again (the open's own writes), over a write made behind it.
 */
async function beforeUpgrade(made) {
  await shot('before-upgrade')
  if (!made) return
  await app.close()
  app = undefined
  // From 1.1 on there are no old values to write: the project's own workflow is the one seeded, kept as it is.
  if (FROM_COMBWORK) return
  const pj = path.join(KEPT_WS, 'demo', TREE_BEFORE, 'project.json')
  const cfg = readJson(pj) ?? {}
  fs.writeFileSync(pj, JSON.stringify({ ...cfg, workflow: { platform: 'none', preset: null, options: {}, kept: { git: { preset: null, options: { ...OLD_GIT_OPTIONS } } } } }, null, 2) + '\n')
  const o = keptGitOptions(TREE_BEFORE)
  check('4.values-written', "Before the upgrade: the project's kept Git options as the release before writes them, written once it has quit", o?.finish === OLD_GIT_OPTIONS.finish && o?.commitMessage === OLD_GIT_OPTIONS.commitMessage, JSON.stringify(readJson(pj)?.workflow ?? null))
}

/** Launch at login's Run values start Combwork.exe, and nothing starts 1.0's exe: the values, or false. */
const startsCombworkOnly = (v) => v.some((x) => /\\Combwork\.exe/i.test(x.command)) && !v.some((x) => startsOld(x.command)) && v

/**
 * Scenario 4's mark from 1.1 on (HI-2727): a real workspace made through the release before's own surface (its window's
 * IPC and its Agent API), for the upgrade to carry over as it is. Each part's ids go into facts.seed, which after-upgrade
 * reads back from this step's record.
 */
async function markCombwork() {
  // Git and the fake Claude Code, as a user installs them (on the user PATH), and Claude Code's own folder, as its first
  // run would make it (HI-2646: Combwork adds a connection only once it is there).
  onUserPath(GIT_CMD)
  res.facts.fakeClaude = ps('& C:\\tools\\combwork-tests\\sandbox\\inside\\fake-claude-install.ps1')
  fs.mkdirSync(path.join(process.env.USERPROFILE, '.claude'), { recursive: true })
  await launch({ env: userEnv().env, cwd: process.env.USERPROFILE })
  res.facts.version = (await api('/v1/health')).version
  // Quit never asks (the lane's agent runs at the end); Claude Code on, the fake its CLI.
  await inv('settings:update', { general: { userName: MARK.userName, launchAtLogin: true, confirmOnQuit: 'never' }, appearance: { theme: MARK.theme }, providers: { 'claude-code': { enabled: true, executablePath: path.join(FAKE_BIN, 'claude.cmd'), checkUpdatesOnLaunch: false } } })
  const saved = await until(async () => { const c = readConfig(); return c?.settings?.general?.userName === MARK.userName && c.settings.general.launchAtLogin === true && c.settings.appearance?.theme === MARK.theme && c }, 10_000)
  check('4.settings-saved', `Before the upgrade: user name "${MARK.userName}", the ${MARK.theme} theme and Launch at login saved`, saved, JSON.stringify(readConfig()?.settings?.general))
  const runs = await until(async () => startsCombworkOnly(runValues()), 15_000)
  res.facts.runBefore = runs || runValues()
  check('4.login-registered', 'Before the upgrade: Launch at login starts Combwork.exe', !!runs, JSON.stringify(res.facts.runBefore))
  // Something in the local profile folder (where accounts live), for the upgrade to leave where it is.
  const local = path.join(process.env.LOCALAPPDATA, 'Combwork')
  fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(path.join(local, LOCAL_MARK), 'kept across the upgrade')
  const found = await until(async () => { const i = (await inv('provider:info'))['claude-code']; return i && !i.checking && i.found && i }, 30_000)
  res.facts.provider = found || (await inv('provider:info'))['claude-code']

  // A connection: the fake Claude Code's account, signed in (the fake signs in to nothing).
  const account = await inv('connections:add', 'claude-code', SEED.connection).catch((e) => ({ error: String(e) }))
  const home = account?.id ? path.join(local, 'accounts', account.id) : null
  if (account?.id) await inv('connections:signIn', account.id).catch((e) => { res.facts.signInError = String(e) })
  const signedIn = !!home && (await until(async () => fs.existsSync(path.join(home, 'fake-account.json')), 30_000))
  const connection = { id: account?.id ?? null, name: SEED.connection, home, files: home && fs.existsSync(home) ? fs.readdirSync(home).sort() : [], error: account?.error }
  check('4.connection-made', 'Before the upgrade: a Claude Code connection added and signed in (the fake)', !!found && signedIn, JSON.stringify({ provider: res.facts.provider, connection }))

  // The workspace, its project a git repository with one commit on main.
  fs.mkdirSync(KEPT_PROJECT, { recursive: true })
  fs.writeFileSync(path.join(KEPT_PROJECT, 'README.md'), '# demo\n')
  fs.writeFileSync(path.join(KEPT_PROJECT, '.gitignore'), '.combwork/\n')
  res.facts.gitInit = [git(KEPT_PROJECT, 'init', '-b', 'main'), git(KEPT_PROJECT, 'add', '-A'), git(KEPT_PROJECT, 'commit', '-m', 'First commit')]
  await inv('workspace:open', KEPT_WS)
  const made = await until(async () => fs.existsSync(path.join(KEPT_WS, TREE_BEFORE, DB_BEFORE)) && fs.existsSync(path.join(KEPT_PROJECT, TREE_BEFORE, 'project.json')), 30_000)
  if (account?.id) res.facts.connectionOn = await inv('connections:setOn', account.id, true).then(() => true, (e) => String(e))
  // Git, on the Pair (agent merges) preset: each card in a slot.
  res.facts.workflowSet = {
    platform: await inv('workflow:setPlatform', KEPT_PROJECT, 'git').catch((e) => ({ error: String(e) })),
    preset: await inv('workflow:setOptions', KEPT_PROJECT, { preset: SEED.preset, options: {} }).then((f) => f?.preset ?? 'saved', (e) => ({ error: String(e) }))
  }
  const workflow = await until(async () => { const w = readJson(path.join(KEPT_PROJECT, TREE_BEFORE, 'project.json'))?.workflow; return w?.preset === SEED.preset && w }, 15_000)
  // Two cards, the first labelled, linked to the second and commented on; both code cards (the lane's needs a slot).
  const create = (title, description) => inv('tasks:create', { title, project: 'demo', description }).catch((e) => ({ error: String(e) }))
  const card = made ? await create(KEPT_CARD, `The plan: ${path.join(KEPT_WS, '.combwork', 'shared', 'plan.md')}`) : null
  const second = made ? await create(SEED.second, 'The card the first links to.') : null
  const numbers = [card?.number, second?.number].filter((n) => typeof n === 'number')
  for (const n of numbers) await inv('tasks:setKind', n, 'code').catch((e) => { res.facts.kindError = String(e) })
  if (numbers.length === 2) {
    await inv('tasks:update', card.number, { labels: [SEED.label], links: [second.number] }).catch((e) => { res.facts.updateError = String(e) })
    await inv('tasks:comment', card.number, SEED.comment).catch((e) => { res.facts.commentError = String(e) })
  }
  // A skill copy as Combwork marks it (HI-2587), for the upgrade to leave as it is.
  fs.mkdirSync(path.join(KEPT_WS, COPY), { recursive: true })
  fs.writeFileSync(path.join(KEPT_WS, COPY, 'SKILL.md'), '---\nname: cw-sandbox-check\n---\n')
  fs.writeFileSync(path.join(KEPT_WS, COPY, '.combwork-copy'), JSON.stringify({ source: 'sandbox', hash: 'h' }) + '\n')
  const logs = fs.readdirSync(path.join(PROFILE, 'logs')).filter((n) => n.endsWith('.log'))
  res.facts.keptWorkspace = { made: !!made, card, second, tree: TREE_BEFORE, workflow: workflow || readJson(path.join(KEPT_PROJECT, TREE_BEFORE, 'project.json'))?.workflow, logs }

  // Advanced overrides under their cw.* ids, one at each level: Combwork's own (advanced.json) and the workspace's own.
  const setAdv = (id, value, scope) => inv('advanced:set', id, value, scope).then(() => null, (e) => String(e))
  res.facts.advancedSet = { app: await setAdv(ADV.app.now, ADV.app.value), workspace: made ? await setAdv(ADV.ws.now, ADV.ws.value, 'workspace') : 'no workspace' }
  const advSaved = await until(async () => readJson(path.join(PROFILE, 'advanced.json'))?.values?.[ADV.app.now] === ADV.app.value && readJson(path.join(KEPT_WS, '.combwork', 'workspace.json'))?.advanced?.[ADV.ws.now] === ADV.ws.value, 10_000)
  check('4.advanced-saved', `Before the upgrade: ${ADV.app.now} = ${ADV.app.value} in advanced.json and the workspace's own ${ADV.ws.now} = ${ADV.ws.value}`, advSaved, JSON.stringify({ set: res.facts.advancedSet, file: readJson(path.join(PROFILE, 'advanced.json'))?.values, ws: readJson(path.join(KEPT_WS, '.combwork', 'workspace.json'))?.advanced }))

  // An agent, and a lane over it recorded through the Agent API (as a script does): in slots, its start lends the
  // builder a slot and starts the agent there (the fake).
  const agent = made ? await inv('agents:add', KEPT_PROJECT, { provider: 'claude-code', name: SEED.builder }).catch((e) => ({ error: String(e) })) : null
  const started = agent?.id && card?.number ? await api('/v1/lanes', 'POST', { project: 'demo', builder: agent.id, cards: [card.number], name: SEED.lane }).catch((e) => ({ error: String(e) })) : null
  const laneId = started?.lane?.id ?? null
  const lane = laneId ? await until(async () => { const l = await laneView(laneId); return l.slot && l }, 90_000) : null
  const slotDir = lane?.slot ? path.join(`${KEPT_WS}.worktrees`, 'demo', lane.slot) : null
  const listed = slotDir && worktreesOf(KEPT_PROJECT).includes(path.resolve(slotDir).toLowerCase())
  res.facts.lane = { agent: agent?.id ?? agent, started: started && { did: started.did, note: started.note, error: started.error }, lane: lane || (laneId ? await laneView(laneId) : null), slotDir, listed }
  check('4.lane-made', 'Before the upgrade: a lane over an agent, lent a slot (a worktree git lists)', !!lane && !!listed, JSON.stringify(res.facts.lane))

  const cards = {}
  for (const n of numbers) cards[n] = await cardView(n)
  const c1 = card?.number ? cards[card.number] : null
  check('4.workspace-made', `Before the upgrade: a workspace with a git project on the ${SEED.preset} preset and two cards (labelled, linked, commented), in ${TREE_BEFORE}, its board ${DB_BEFORE}, the log ${LOG_BEFORE}`, !!made && numbers.length === 2 && !!workflow && !!c1 && c1.labels?.includes(SEED.label) && c1.links?.includes(second.number) && c1.comments?.some((t) => t.includes(SEED.comment)) && logs.includes(LOG_BEFORE), JSON.stringify({ ...res.facts.keptWorkspace, cards, workflowSet: res.facts.workflowSet, gitInit: res.facts.gitInit.map((g) => g.ok) }))
  res.facts.seed = { connection, cards, card: card?.number ?? null, second: second?.number ?? null, lane: lane ? { ...lane } : null, slotDir, workflow: workflow || null, advanced: { app: ADV.app.value, ws: ADV.ws.value } }
  save()
  await beforeUpgrade(made)
}

/**
 * Scenario 4's after-upgrade from 1.1 on (HI-2727): what mark seeded, read back by its ids and unchanged. Run once the
 * kept workspace is open again.
 */
async function afterCombwork() {
  const seed = markRecord()?.facts?.seed
  res.facts.seedRead = !!seed
  const local = path.join(process.env.LOCALAPPDATA, 'Combwork')
  const oldMade = [process.env.LOCALAPPDATA, process.env.APPDATA].filter((d) => fs.existsSync(path.join(d, OLD_NAME)))
  check('4.local-kept', "The local folder kept where it was, with its data: %LOCALAPPDATA%\\Combwork; no folder of 1.0's made", fs.existsSync(path.join(local, LOCAL_MARK)) && !oldMade.length, JSON.stringify({ mark: fs.existsSync(path.join(local, LOCAL_MARK)), oldMade }))
  const runs = await until(async () => startsCombworkOnly(runValues()), 15_000)
  res.facts.runAfter = runs || runValues()
  check('4.login-kept', 'Launch at login still starts Combwork.exe, and only it', !!runs, JSON.stringify(res.facts.runAfter))
  const fallback = await page.locator('.toast', { hasText: OLD_FALLBACK_NOTICE }).count()
  check('4.no-fallback', 'No notice that Combwork runs from its old folders', fallback === 0, `${fallback} such notice(s)`)

  // The connection: listed by its id and name, its home and the files it had.
  const c = seed?.connection
  const list = await inv('connections:list').catch((e) => ({ error: String(e) }))
  const files = c?.home && fs.existsSync(c.home) ? fs.readdirSync(c.home) : []
  res.facts.connectionAfter = { listed: !!c?.id && JSON.stringify(list).includes(c.id), files }
  check('4.connection-kept', `The connection "${SEED.connection}" kept: listed by its id, its home with the files it had`, !!c?.id && res.facts.connectionAfter.listed && JSON.stringify(list).includes(c.name) && c.files.length > 0 && c.files.every((f) => files.includes(f)), JSON.stringify({ before: c, after: res.facts.connectionAfter }))

  // The workspace: its .combwork as it was, nothing of 1.0's made.
  const oldTrees = [path.join(KEPT_WS, OLD_DIR), path.join(KEPT_PROJECT, OLD_DIR)].filter((d) => fs.existsSync(d))
  const kept = await until(async () => fs.existsSync(path.join(KEPT_WS, '.combwork', 'combwork.db')) && fs.existsSync(path.join(KEPT_PROJECT, '.combwork', 'project.json')), 30_000)
  check('4.workspace-kept', 'The workspace from before opens from its own .combwork (the workspace\'s and the project\'s), none of 1.0\'s made', !!kept && !oldTrees.length, JSON.stringify({ kept, oldTrees, ws: fs.existsSync(KEPT_WS) ? fs.readdirSync(KEPT_WS) : null }))

  // The cards: each as it was (title, description, kind, labels, links), its comments kept; the second, which nothing
  // started, still where it was.
  const after = {}
  for (const n of Object.keys(seed?.cards ?? {})) after[n] = await cardView(Number(n))
  res.facts.cardsAfter = after
  const same = (b, a) => !!a && !a.error && a.title === b.title && a.description === b.description && a.kind === b.kind && JSON.stringify(a.labels) === JSON.stringify(b.labels) && JSON.stringify(a.links) === JSON.stringify(b.links) && b.comments.every((t) => a.comments.includes(t))
  const before = Object.entries(seed?.cards ?? {})
  const pathKept = after[seed?.card]?.description === `The plan: ${path.join(KEPT_WS, '.combwork', 'shared', 'plan.md')}`
  check('4.workspace-card', 'Its cards are on the board as they were: titles, descriptions (the path into .combwork), kinds, labels, links and comments', before.length === 2 && before.every(([n, b]) => same(b, after[n])) && pathKept && after[seed.second]?.column === seed.cards[seed.second].column, JSON.stringify({ before: seed?.cards, after }))

  // The project's workflow as it was: its platform, its preset and each option it had (one the new release adds is new,
  // not a change), nothing converted.
  const wf = readJson(path.join(KEPT_PROJECT, '.combwork', 'project.json'))?.workflow ?? null
  const optionsKept = !!seed?.workflow && Object.entries(seed.workflow.options ?? {}).every(([k, v]) => JSON.stringify(wf?.options?.[k]) === JSON.stringify(v))
  check('4.workflow-kept', `The project's workflow kept: the ${SEED.preset} preset and each of its options as they were`, !!seed?.workflow && wf?.platform === seed.workflow.platform && wf?.preset === seed.workflow.preset && optionsKept, JSON.stringify({ before: seed?.workflow, after: wf }))

  // The advanced overrides at both levels, under the same ids.
  const state = await inv('advanced:state').catch((e) => ({ error: String(e) }))
  res.facts.advancedAfter = { file: readJson(path.join(PROFILE, 'advanced.json'))?.values ?? null, values: state?.values, workspace: state?.workspace }
  check('4.advanced-kept', `The advanced overrides kept: ${ADV.app.now} = ${ADV.app.value} and the workspace's own ${ADV.ws.now} = ${ADV.ws.value}`, state?.values?.[ADV.app.now] === ADV.app.value && state?.workspace?.[ADV.ws.now] === ADV.ws.value && res.facts.advancedAfter.file?.[ADV.app.now] === ADV.app.value, JSON.stringify(res.facts.advancedAfter))

  // The lane and its slot: the same lane (id, builder, cards), still running, in the same slot, a worktree git still lists.
  const l = seed?.lane
  const laneNow = l?.id ? await laneView(l.id) : null
  res.facts.laneAfter = laneNow
  check('4.lane-kept', 'The lane kept: its id, builder and cards as they were, still running', !!l && !!laneNow && !laneNow.error && laneNow.builder === l.builder && JSON.stringify(laneNow.cards) === JSON.stringify(l.cards) && laneNow.state === l.state, JSON.stringify({ before: l, after: laneNow }))
  const listed = !!seed?.slotDir && worktreesOf(KEPT_PROJECT).includes(path.resolve(seed.slotDir).toLowerCase())
  check('4.slot-kept', `The lane's slot kept: ${l?.slot ?? '(none)'}, its folder a worktree git lists, still the lane's`, !!l?.slot && laneNow?.slot === l.slot && fs.existsSync(seed.slotDir) && listed, JSON.stringify({ before: l?.slot, after: laneNow?.slot, dir: seed?.slotDir, listed, worktrees: worktreesOf(KEPT_PROJECT) }))
}

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
    // By the descriptors' ids (HI-2727; a unit test holds PROVIDER_IDS to src/shared/providers.ts), not a count.
    const ids = Array.isArray(list) ? list.map(p => p.id) : []
    check('2.api-providers', `Agent API: every provider known (${PROVIDER_IDS.join(', ')}), none on, none installed`, Array.isArray(list) && JSON.stringify([...ids].sort()) === JSON.stringify([...PROVIDER_IDS].sort()) && list.every(p => !p.enabled && !p.installed), JSON.stringify(list.map?.(p => ({ id: p.id, enabled: p.enabled, installed: p.installed })) ?? list))

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
    res.facts.install = ps('& C:\\tools\\combwork-tests\\sandbox\\inside\\fake-claude-install.ps1')
    const appPath = await app.evaluate(() => process.env.PATH || process.env.Path || '')
    check('3.user-path', 'The new folder is on the user PATH, not on Combwork\'s own PATH yet', !appPath.toLowerCase().includes('fakeclaude'), appPath.slice(0, 300))
    if (dialog) await dialog.locator('button', { hasText: 'Check again' }).click()
    const found = dialog && await until(async () => { const i = (await inv('provider:info'))['claude-code']; return i && !i.checking && i.found && i }, 30_000)
    res.facts.after = found || (await inv('provider:info'))['claude-code']
    check('3.check-again-finds', '"Check again" finds it, without restarting Combwork', found && found.source === 'PATH' && found.version === '2.1.999' && /claude\.cmd$/i.test(found.path || '') && app.process().pid === pid, dialog ? JSON.stringify(res.facts.after) : `${NO_DIALOG}, so "Check again" was never pressed; ${JSON.stringify(res.facts.after)}`)
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

  // Scenario 6 (for the fresh-install comparison, no model): what a fresh Combwork makes of a new workspace.
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
    // Recorded once Combwork has set the workspace up: its status names it with its Combwork skills, which it replies with only
    // once the open has brought the bundled skills and modes up to date. Not set up within the bound: the check fails,
    // and what is there is kept apart (workspaceNotSetUp), never recorded as the workspace's.
    const status = await workspaceSetUp(() => api('/v1/status'), ws)
    const now = tree(path.join(ws, '.combwork'), 3)
    if (status) res.facts.workspaceTree = now
    else res.facts.workspaceNotSetUp = now
    res.facts.projectTree = tree(path.join(ws, 'demo', '.combwork'), 1)
    try { res.facts.workspaceJson = JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'workspace.json'), 'utf8')) } catch { /* recorded as missing */ }
    check('6.combwork-folder', 'Combwork creates the workspace\'s .combwork folder and sets it up (its status lists its Combwork skills)', status && Array.isArray(res.facts.workspaceTree), status ? 'no .combwork folder' : `Combwork didn't say the workspace was set up within 60 s (GET /v1/status): ${JSON.stringify(now).slice(0, 300)}`)
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
    if (FROM_COMBWORK) return markCombwork()
    await launch()
    res.facts.version = (await api('/v1/health')).version
    // Launch at login on too (HI-2460): 1.0 registers its own exe, which the upgrade replaces with Combwork.exe.
    await inv('settings:update', { general: { userName: MARK.userName, launchAtLogin: true }, appearance: { theme: MARK.theme } })
    const saved = await until(async () => { const c = readConfig(); return c?.settings?.general?.userName === MARK.userName && c.settings.general.launchAtLogin === true && c.settings.appearance?.theme === MARK.theme && c }, 10_000)
    check('4.settings-saved', `Before the upgrade: user name "${MARK.userName}", the ${MARK.theme} theme and Launch at login saved`, saved, JSON.stringify(readConfig()?.settings?.general))
    // 1.0's own folders and its Launch at login (HI-2460, HI-2461): an RC has moved them already.
    if (!FROM_RC) {
      // Something in the local profile folder (where accounts live), for the upgrade to carry across.
      const local = path.join(process.env.LOCALAPPDATA, OLD_NAME)
      fs.mkdirSync(local, { recursive: true })
      fs.writeFileSync(path.join(local, LOCAL_MARK), 'kept across the upgrade')
      fs.mkdirSync(path.join(local, TRUST_HOME), { recursive: true })
      fs.writeFileSync(path.join(local, TRUST_HOME, '.claude.json'), JSON.stringify(TRUST_JSON, null, 2))
      res.facts.runBefore = runValues()
      check('4.login-registered', "Before the upgrade: Launch at login starts 1.0's exe", res.facts.runBefore.some((v) => startsOld(v.command)), JSON.stringify(res.facts.runBefore))
    }
    // A workspace the release before makes in its own folder (HI-2462, HI-2506): a project and a card naming a note by its path,
    // for the upgrade's first open to move to .combwork.
    fs.mkdirSync(path.join(KEPT_WS, 'demo'), { recursive: true })
    fs.writeFileSync(path.join(KEPT_WS, 'demo', 'README.md'), '# demo\n')
    await inv('workspace:open', KEPT_WS)
    const made = await until(async () => fs.existsSync(path.join(KEPT_WS, TREE_BEFORE, OLD_DB)) && fs.existsSync(path.join(KEPT_WS, 'demo', TREE_BEFORE, 'project.json')), 30_000)
    let card = null
    if (made) card = await inv('tasks:create', { title: KEPT_CARD, project: 'demo', description: `The plan: ${path.join(KEPT_WS, TREE_BEFORE, 'shared', 'plan.md')}` }).catch((e) => ({ error: String(e) }))
    // A skill copy as the release before marks it (HI-2587), for the upgrade to rename its marker.
    fs.mkdirSync(path.join(KEPT_WS, COPY), { recursive: true })
    fs.writeFileSync(path.join(KEPT_WS, COPY, 'SKILL.md'), '---\nname: cw-sandbox-check\n---\n')
    fs.writeFileSync(path.join(KEPT_WS, COPY, OLD_COPY_MARKER), JSON.stringify({ source: 'sandbox', hash: 'h' }) + '\n')
    res.facts.keptWorkspace = { made: !!made, card, tree: TREE_BEFORE, logs: fs.readdirSync(path.join(PROFILE, 'logs')).filter((n) => n.endsWith('.log')) }
    check('4.workspace-made', `Before the upgrade: a workspace with a project and a card, in ${TREE_BEFORE}, its board ${OLD_DB}, the log ${OLD_LOG}`, !!made && typeof card?.number === 'number' && res.facts.keptWorkspace.logs.includes(OLD_LOG), JSON.stringify(res.facts.keptWorkspace))
    if (FROM_RC) return void (await beforeUpgrade(made))
    // Advanced overrides under the release before's old ids (HI-2518), one at each level: Combwork's own (advanced.json
    // in the profile) and the workspace's own (its workspace.json), for the upgrade to bring back under cw.*.
    const setAdv = (id, value, scope) => inv('advanced:set', id, value, scope).then(() => null, (e) => String(e))
    res.facts.advancedSet = { app: await setAdv(ADV.app.old, ADV.app.value), workspace: made ? await setAdv(ADV.ws.old, ADV.ws.value, 'workspace') : 'no workspace' }
    const advSaved = await until(async () => readJson(path.join(PROFILE, 'advanced.json'))?.values?.[ADV.app.old] === ADV.app.value && readJson(path.join(KEPT_WS, OLD_DIR, 'workspace.json'))?.advanced?.[ADV.ws.old] === ADV.ws.value, 10_000)
    check('4.advanced-saved', `Before the upgrade: ${ADV.app.old} = ${ADV.app.value} in advanced.json and the workspace's own ${ADV.ws.old} = ${ADV.ws.value}`, advSaved, JSON.stringify({ set: res.facts.advancedSet, file: readJson(path.join(PROFILE, 'advanced.json'))?.values, ws: readJson(path.join(KEPT_WS, OLD_DIR, 'workspace.json'))?.advanced }))
    await beforeUpgrade(made)
  },

  // Scenario 8 (HI-2460): a Windows notification from the installed app, under its own app ID: Windows records an app
  // that has notified under Notifications\Settings\<its AUMID>.
  async notify() {
    await launch()
    const aumid = 'it.surmise.combwork'
    res.facts.exe = CW_EXE
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

  // Scenario 9 (HI-2592): a new user's first session, kept for clean-scan.cjs. Each step goes on whatever the one before
  // did, so the scan has as much as can be made; a step that didn't work is its check's failure.
  async clean() {
    const pages = []
    const keep = async (where) => {
      try { pages.push({ where, text: await windowText() }) } catch (e) { pages.push({ where, text: '', error: String(e.message) }) }
      fs.writeFileSync(path.join(OUT, `${prefix}-window.json`), JSON.stringify(pages, null, 2))
    }
    // Git (this machine's, mapped at C:\tools\git) and the fake Claude Code, as a user installs them: on the user PATH.
    const gitCmd = GIT_CMD
    onUserPath(gitCmd)
    res.facts.fakeClaude = ps('& C:\\tools\\combwork-tests\\sandbox\\inside\\fake-claude-install.ps1')
    // Then Claude Code run once, as a new user does after installing it (HI-2646): its first run makes its folder,
    // %USERPROFILE%\.claude, which Combwork needs before it adds a connection and never makes itself (accounts.ts,
    // main.accounts.noHome). The fake runs only in a test folder (CLAUDE_CONFIG_DIR), so the folder is made in its place.
    const claudeHome = path.join(process.env.USERPROFILE, '.claude')
    const hadHome = fs.existsSync(claudeHome)
    fs.mkdirSync(claudeHome, { recursive: true })
    res.facts.claudeFirstRun = { home: claudeHome, there: hadHome }
    // Combwork starts with a user's environment (userEnv). What was left out is recorded.
    const { env, dropped } = userEnv()
    res.facts.harnessEnvLeftOut = dropped
    await launch({ env, cwd: process.env.USERPROFILE })
    res.facts.version = (await api('/v1/health')).version
    res.facts.appName = await app.evaluate(({ app: a }) => a.getName())
    check('9.first-run', `First run shows the start screen ("${res.facts.appName}")`, (await page.locator('.welcome h1', { hasText: res.facts.appName }).count()) > 0, (await bodyText()).slice(0, 400))
    await keep('start screen')
    await shot('start')

    // Claude Code turned on as a user does (the banner's "Choose providers", its switch): the fake is found on the PATH.
    await page.locator('.providers-banner button', { hasText: 'Choose providers' }).click({ timeout: 10_000 }).catch(() => {})
    await keep('Provider Setup')
    await page.locator('[role="switch"][aria-label="Use Claude Code"]').click({ timeout: 10_000 }).catch(() => {})
    const found = await until(async () => { const i = (await inv('provider:info'))['claude-code']; return i && !i.checking && i.found && i }, 30_000)
    check('9.provider-on', 'Claude Code turned on and found (the fake, 2.1.999)', found && found.version === '2.1.999', JSON.stringify((await inv('provider:info'))['claude-code']))
    await keep('Provider Setup, Claude Code on')
    await page.keyboard.press('Escape')

    // An account, signed in through the CLI's own sign-in (the fake signs in to nothing).
    const account = await inv('connections:add', 'claude-code', 'Sandbox').catch((e) => ({ error: String(e) }))
    const home = account?.id ? path.join(process.env.LOCALAPPDATA, 'Combwork', 'accounts', account.id) : null
    if (account?.id) await inv('connections:signIn', account.id).catch((e) => { res.facts.signInError = String(e) })
    const signedIn = !!home && (await until(async () => fs.existsSync(path.join(home, 'fake-account.json')), 30_000))
    res.facts.account = { id: account?.id, error: account?.error, home }
    check('9.account', 'A Claude Code account added and signed in', signedIn, JSON.stringify(res.facts.account))

    // A workspace with a git project, as a user makes one: a folder, git init, then Open Workspace.
    const ws = path.join(process.env.USERPROFILE, 'Workspaces', 'Clean')
    const proj = path.join(ws, 'demo')
    res.facts.workspace = ws
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 'README.md'), '# demo\n')
    try { res.facts.gitInit = execFileSync(path.join(gitCmd, 'git.exe'), ['init'], { cwd: proj, encoding: 'utf8', env, timeout: 60_000 }).trim() } catch (e) { res.facts.gitInit = String(e.message) }
    check('9.git-project', 'The project is a git repository (git init)', fs.existsSync(path.join(proj, '.git', 'HEAD')), res.facts.gitInit)
    await inv('workspace:open', ws)
    const status = await workspaceSetUp(() => api('/v1/status'), ws)
    check('9.workspace', 'The workspace opens and is set up', !!status && fs.existsSync(path.join(ws, '.combwork')), 'not set up within 60 s')
    await keep('workspace')
    for (const view of VIEWS) {
      try {
        await page.getByRole('button', { name: view.name, exact: true }).first().click({ timeout: 5000 })
        await viewReady(view, (sel) => page.locator(sel).count())
        await keep(`view: ${view.name}`)
      } catch (e) {
        res.facts[`view ${view.name}`] = String(e.message).slice(0, 300)
      }
    }

    // The account turned on in this workspace as a user does (HI-2650): nothing is turned on by itself, so the project,
    // with no agent yet, says the account is off here and offers Turn On Here on its empty card, which the user clicks.
    await page.locator('.activity-btn[aria-label="Projects"]').click({ timeout: 5000 }).catch(() => {})
    await page.getByText('demo', { exact: true }).first().click({ timeout: 10_000 }).catch(() => {})
    const offHere = page.locator('.session-empty-card [data-connection-setup="empty"][data-off-here="one"]')
    const offered = await until(async () => (await offHere.count()) > 0 && /Sandbox, your Claude Code account, is off in this workspace/.test(await offHere.innerText()), 20_000)
    res.facts.offHere = await offHere.innerText().catch((e) => String(e.message))
    check('9.account-off-here', "The empty project says the account is off here and offers Turn On Here (nothing on by itself)", !!offered, res.facts.offHere)
    await keep('project, account off here')
    await shot('off-here')
    if (account?.id) await offHere.locator(`[data-turn-on-here="${account.id}"]`).click({ timeout: 10_000 }).catch((e) => { res.facts.turnOnError = String(e.message) })
    res.facts.accountOn = !!account?.id && !!(await until(async () => ((await inv('connections:list')).workspace['claude-code']?.on ?? []).includes(account.id), 20_000))
    check('9.account-on', 'Turn On Here turns the account on in this workspace', res.facts.accountOn, res.facts.turnOnError || '')

    // An agent, started briefly: its first task is `set`, which the fake runs in the session's shell (fake-shell.jsonl).
    const agent = await inv('agents:add', proj, { provider: 'claude-code' }).catch((e) => ({ error: String(e) }))
    res.facts.agent = { id: agent?.id, error: agent?.error }
    const key = `session:${proj.toLowerCase()}#${agent?.id}`
    let started = false
    if (agent?.id) started = await inv('session:start', proj, { agentId: agent.id, prompt: 'shell: set' }).then(() => true, (e) => { res.facts.startError = String(e); return false })
    let trusted = false
    const shellLog = home && path.join(home, 'fake-shell.jsonl')
    const setRun = () => { try { return fs.readFileSync(shellLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.cmd === 'set') } catch { return null } }
    // Its folder is new to it: it asks whether to trust it, and the user says yes (Enter).
    const ran = started && (await until(async () => {
      if (!trusted && /trust this folder/i.test(await inv('pty:buffer', key).catch(() => ''))) { trusted = true; await inv('pty:write', key, '\r') }
      return setRun()
    }, 60_000))
    check('9.agent-started', 'An agent starts in the project (the fake Claude Code)', started && !!(await inv('pty:buffer', key).catch(() => '')), JSON.stringify(res.facts.agent) + (res.facts.startError || ''))
    if (ran) fs.writeFileSync(path.join(OUT, `${prefix}-agent-env.txt`), ran.stdout)
    check('9.agent-env', "The agent's environment captured (`set` in its session)", !!ran && /^PATH=/im.test(ran.stdout), ran ? ran.stdout.slice(0, 300) : 'set never ran')
    await keep('agent')
    await shot('agent')
    if (started) await inv('session:stop', proj, agent.id).catch((e) => { res.facts.stopError = String(e) })

    // A card, and the board showing it.
    const card = await inv('tasks:create', { title: 'A first card', project: 'demo', description: 'Made on a clean install.' }).catch((e) => ({ error: String(e) }))
    await page.getByRole('button', { name: 'Task Board', exact: true }).first().click({ timeout: 5000 }).catch(() => {})
    const shown = await until(async () => (await page.locator('.board-view', { hasText: 'A first card' }).count()) > 0, 20_000)
    check('9.card', 'A card made, on the board', typeof card?.number === 'number' && shown, JSON.stringify(card))
    await keep('board')
    await shot('board')

    // Settings, every section.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+,')
    const rows = page.locator('.settings-nav .row[data-section]')
    const opened = await until(async () => (await rows.count()) > 0, 10_000)
    const sections = opened ? await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-section'))) : []
    res.facts.settingsSections = sections
    let seen = 0
    for (const s of sections) {
      try {
        await page.locator(`.settings-nav .row[data-section="${s}"]`).click({ timeout: 5000 })
        await painted()
        await keep(`Settings: ${s}`)
        if (!seen) await shot('settings')
        seen++
      } catch (e) {
        res.facts[`settings ${s}`] = String(e.message).slice(0, 300)
      }
    }
    check('9.settings', `Settings opens, each section shown (${seen} of ${sections.length})`, sections.length > 0 && seen === sections.length, JSON.stringify(sections))
    await page.keyboard.press('Escape')

    // Help → Copy Diagnostics, its Copy, and what it put on the clipboard.
    await app.evaluate(({ clipboard }) => clipboard.clear())
    const diagOpen = await paletteCommand('help.diagnostics', 'Copy Diagnostics')
    const copy = page.locator('.dialog', { hasText: 'Copy Diagnostics' }).locator('button.btn.primary')
    const ready = diagOpen && (await until(async () => (await copy.count()) === 1 && (await copy.isEnabled()), 30_000))
    await keep('Copy Diagnostics')
    if (ready) await copy.click()
    const diag = ready && (await until(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) || false, 10_000))
    if (diag) fs.writeFileSync(path.join(OUT, `${prefix}-diagnostics.txt`), diag)
    check('9.diagnostics', 'Copy Diagnostics copies its text', !!diag, diagOpen ? 'nothing copied' : 'the palette found no Copy Diagnostics')

    // Export Board to JSON, into a folder of Documents (Windows' folder picker answered with it).
    const exportDir = path.join(process.env.USERPROFILE, 'Documents', 'Board export')
    fs.mkdirSync(exportDir, { recursive: true })
    res.facts.exportDir = exportDir
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }) }, exportDir)
    const exportRan = await paletteCommand('task.exportBoard', 'Export Board')
    const exported = exportRan && (await until(async () => fs.readdirSync(exportDir).some((d) => fs.statSync(path.join(exportDir, d)).isDirectory() && fs.readdirSync(path.join(exportDir, d)).length > 0), 20_000))
    check('9.export', 'Export Board to JSON writes the board', !!exported, exportRan ? JSON.stringify(fs.readdirSync(exportDir)) : 'the palette found no Export Board')
    await keep('after the export')

    // Quit, as a user does (the app's own quit), and wait for it to end.
    const proc = app.process()
    await app.evaluate(({ app: a }) => a.quit()).catch(() => {})
    const quit = await until(async () => proc.exitCode !== null, 60_000)
    check('9.quit', 'Combwork quits', quit, `still running (pid ${proc.pid})`)
    if (quit) app = null
  },

  async 'after-upgrade'() {
    res.facts.closedForceRun = closeRunningApp()
    // From 1.1 on, with Git and the fake on its PATH, as mark started the release before (the seeded project is a git one).
    await launch(FROM_COMBWORK ? { env: userEnv().env, cwd: process.env.USERPROFILE } : {})
    res.facts.version = (await api('/v1/health')).version
    const c = readConfig()
    res.facts.settings = { userName: c?.settings?.general?.userName, theme: c?.settings?.appearance?.theme, lastRunVersion: c?.lastRunVersion }
    check('4.settings-kept', 'Settings kept: user name and theme', res.facts.settings.userName === MARK.userName && res.facts.settings.theme === MARK.theme, JSON.stringify(res.facts.settings))
    check('4.theme-applied', 'The window is in the kept theme', (await page.evaluate(() => document.documentElement.dataset.theme)) === MARK.theme, 'theme not applied')
    // HI-2460: the app that runs is Combwork's, from its moved profile folders, with the local data and the installer's record.
    res.facts.exe = CW_EXE
    res.facts.profile = PROFILE
    check('4.combwork-runs', 'Combwork.exe runs after the upgrade, from %APPDATA%\\Combwork', CW_EXE === COMBWORK_EXE && PROFILE === path.join(process.env.APPDATA, 'Combwork'), `${CW_EXE}, ${PROFILE}`)
    // 1.0's folders, its record and its Launch at login (HI-2460, HI-2461): an RC moved them already, and a 1.1 never had them.
    if (ERA === '1.0') {
      const localNew = path.join(process.env.LOCALAPPDATA, 'Combwork')
      check('4.local-moved', "The local folder moved with its data: %LOCALAPPDATA%\\Combwork, none of 1.0's", fs.existsSync(path.join(localNew, LOCAL_MARK)) && !fs.existsSync(path.join(process.env.LOCALAPPDATA, OLD_NAME)), fs.readdirSync(process.env.LOCALAPPDATA).filter((n) => OLD_NAME_RE.test(n) || /combwork/i.test(n)).join(', '))
      let trustAfter = null
      try { trustAfter = JSON.parse(fs.readFileSync(path.join(localNew, TRUST_HOME, '.claude.json'), 'utf8')) } catch { /* below */ }
      const trustEntries = (j) => Object.entries(j?.projects ?? {}).map(([k, v]) => [k, v?.hasTrustDialogAccepted])
      check('4.trust-kept', "A connection home's Claude Code folder trust moved as it was: trusted stays trusted, untrusted stays untrusted, nothing added", JSON.stringify(trustEntries(trustAfter)) === JSON.stringify(trustEntries(TRUST_JSON)), JSON.stringify(trustAfter))
      check('4.roaming-moved', "The roaming folder moved: none of 1.0's left", !fs.existsSync(path.join(process.env.APPDATA, OLD_NAME)), fs.readdirSync(process.env.APPDATA).filter((n) => OLD_NAME_RE.test(n) || /combwork/i.test(n)).join(', '))
      let rec = null
      try { rec = JSON.parse(fs.readFileSync(path.join(localNew, 'profile-move.json'), 'utf8')) } catch { /* below */ }
      res.facts.record = rec
      check('4.record', "The installer's record arrived with the local folder (v 1, by installer)", rec?.v === 1 && rec.by === 'installer' && String(rec.from).toLowerCase().endsWith(`\\${OLD_NAME}`.toLowerCase()), JSON.stringify(rec))
      // Its Launch at login: written for Combwork.exe at start (loginItem.ts), the 1.0 app's removed by the installer.
      const runs = await until(async () => { const v = runValues(); return v.some((x) => /\\Combwork\.exe/i.test(x.command)) && v }, 15_000)
      res.facts.runAfter = runs || runValues()
      check('4.login-moved', "Launch at login starts Combwork.exe, and nothing starts 1.0's exe", !!runs && !runs.some((x) => startsOld(x.command)), JSON.stringify(res.facts.runAfter))
      const fallback = await page.locator('.toast', { hasText: OLD_FALLBACK_NOTICE }).count()
      check('4.no-fallback', 'No notice that Combwork runs from its old folders', fallback === 0, `${fallback} such notice(s)`)
    }
    // The workspace made before the upgrade, opened (again, or restored at start): its 1.0 folders moved to .combwork,
    // its board and the card's path with them (HI-2462, HI-2506).
    await inv('workspace:open', KEPT_WS).catch(() => undefined)
    let card = null
    if (FROM_COMBWORK) {
      // From 1.1 on (HI-2727): nothing moved; everything mark seeded read back as it was.
      await afterCombwork()
      const seeded = markRecord()?.facts?.seed?.card
      card = typeof seeded === 'number' ? { number: seeded } : null
    } else {
      const movedNow = () => fs.existsSync(path.join(KEPT_WS, '.combwork', 'combwork.db')) && !fs.existsSync(path.join(KEPT_WS, OLD_DIR)) && fs.existsSync(path.join(KEPT_WS, 'demo', '.combwork', 'project.json')) && !fs.existsSync(path.join(KEPT_WS, 'demo', OLD_DIR))
      const moved = await until(async () => movedNow(), 30_000)
      res.facts.keptWorkspaceAfter = fs.existsSync(KEPT_WS) ? fs.readdirSync(KEPT_WS) : null
      check('4.workspace-moved', "The workspace from before opens with its 1.0 folders moved to .combwork (the workspace's and the project's)", !!moved, JSON.stringify(res.facts.keptWorkspaceAfter))
      const cards = await inv('tasks:list').catch((e) => ({ error: String(e) }))
      card = Array.isArray(cards) ? cards.find((x) => x.title === KEPT_CARD) : null
      res.facts.keptCard = card ? { number: card.number, description: card.description } : cards
      check('4.workspace-card', 'Its card is on the board, its path now into .combwork', !!card && card.description === `The plan: ${path.join(KEPT_WS, '.combwork', 'shared', 'plan.md')}`, JSON.stringify(res.facts.keptCard))
      // HI-2598: the stored values converted once: the project's kept Git options, and the card's facts' actors.
      // Waited for (HI-2645): the open converts it in its own time, and a read as it is renamed into place reads nothing.
      const converted = (o) => o?.finish === 'combworkMerges' && o?.commitMessage === 'combwork'
      const keptGit = (await until(async () => { const o = keptGitOptions('.combwork'); return converted(o) && o }, 15_000)) || keptGitOptions('.combwork')
      check('4.values-options', "The project's kept Git options say Combwork's (combworkMerges, Combwork's commit message), no old value left", converted(keptGit), JSON.stringify(keptGit ?? readJson(path.join(KEPT_WS, 'demo', '.combwork', 'project.json'))?.workflow ?? null))
    }
    const facts = card ? await inv('tasks:facts', card.number).catch(() => null) : null
    check('4.values-facts', "No fact of the card made before names the old app as its actor", Array.isArray(facts) && !facts.some((x) => x.actor === OLD_ACTOR || x.data?.by === OLD_ACTOR), JSON.stringify(facts?.map((x) => [x.kind, x.actor])))
    // HI-2587: the names upgrade. The board's file and its copies, the log, the workspace's files, the skill copy's marker:
    // Combwork's names, nothing of the old left, the record written; from 1.0 and from an RC alike.
    const dir = path.join(KEPT_WS, '.combwork')
    const listed = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : [])
    res.facts.names = { combwork: listed(dir), backups: listed(path.join(dir, 'backups')), logs: listed(path.join(PROFILE, 'logs')), copy: listed(path.join(KEPT_WS, COPY)) }
    check('4.board-file', `The board is .combwork\\combwork.db, with the card made before; no ${OLD_DB} or its sidecars left`, res.facts.names.combwork.includes('combwork.db') && !res.facts.names.combwork.some((n) => n.startsWith(OLD_DB)) && !!card, JSON.stringify(res.facts.names.combwork))
    check('4.board-backups', "The board's copies in backups take Combwork's names", !res.facts.names.backups.some((n) => n.startsWith(OLD_BACKUP_PREFIX)), JSON.stringify(res.facts.names.backups))
    let log = ''
    try { log = fs.readFileSync(path.join(PROFILE, 'logs', 'combwork.log'), 'utf8') } catch { /* below */ }
    // Each release's start line by its name and version (HI-2645): an RC can carry the version of the release before.
    res.facts.releasesStarted = releasesStarted(log, OLD_START_LINE)
    check('4.log-file', `The log is combwork.log, with the release before's lines in it (its start line and this one's); no ${OLD_LOG} left`, !res.facts.names.logs.includes(OLD_LOG) && res.facts.releasesStarted.length >= 2, JSON.stringify({ logs: res.facts.names.logs, started: res.facts.releasesStarted }))
    let gitignore = ''
    try { gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') } catch { /* below */ }
    check('4.workspace-files', "The workspace's .gitignore is Combwork's, for combwork.db, keeping the names upgrade's record out", /\(added by Combwork, #1017\)/.test(gitignore.split(/\r?\n/)[0]) && /^combwork\.db\r?$/m.test(gitignore) && /^combwork-names\.json\r?$/m.test(gitignore) && !gitignore.split(/\r?\n/).some((l) => l.startsWith(OLD_DB)), gitignore.slice(0, 600))
    check('4.copy-marker', "The project's skill copy has Combwork's marker (.combwork-copy), its content as it was", res.facts.names.copy.includes('.combwork-copy') && !res.facts.names.copy.includes(OLD_COPY_MARKER) && readJson(path.join(KEPT_WS, COPY, '.combwork-copy'))?.hash === 'h', JSON.stringify(res.facts.names.copy))
    check('4.names-done', 'The names upgrade recorded itself done (.combwork\\combwork-names.json)', readJson(path.join(dir, 'combwork-names.json'))?.version === NAMES_VERSION,JSON.stringify(res.facts.names.combwork))
    const oldNames = [...res.facts.names.combwork, ...res.facts.names.logs].filter((n) => n.toLowerCase().startsWith(OLD_NAME.toLowerCase()))
    check('4.no-old-names', "No file under the old names left in the workspace's .combwork or the profile's logs", oldNames.length === 0, JSON.stringify(oldNames))
    if (ERA === '1.0') {
      // The advanced overrides made before (HI-2518): read back under their cw.* ids, in the app (Settings' state, the Agent
      // API's settings read) and on disk (advanced.json rewritten at once; workspace.json at its next save, so not checked),
      // with nothing left under the old id; and an agent naming the old id told the new one.
      const fileNow = () => readJson(path.join(PROFILE, 'advanced.json'))?.values ?? null
      const rewritten = await until(async () => { const v = fileNow(); return v && v[ADV.app.now] === ADV.app.value && !(ADV.app.old in v) && v }, 15_000)
      const state = await inv('advanced:state').catch((e) => ({ error: String(e) }))
      const viaApi = await api(`/v1/settings/${encodeURIComponent(`advanced.${ADV.app.now}`)}`).catch((e) => ({ error: String(e) }))
      const wsApi = await api(`/v1/settings/${encodeURIComponent(`workspace.advanced.${ADV.ws.now}`)}`).catch((e) => ({ error: String(e) }))
      res.facts.advancedAfter = { file: fileNow(), values: state?.values, workspace: state?.workspace, api: viaApi, wsApi }
      check('4.advanced-kept', `The advanced overrides come back under cw.*: ${ADV.app.now} = ${ADV.app.value} (advanced.json rewritten, nothing under ${ADV.app.old}) and the workspace's own ${ADV.ws.now} = ${ADV.ws.value}`, !!rewritten && state?.values?.[ADV.app.now] === ADV.app.value && !(ADV.app.old in (state?.values ?? {})) && state?.workspace?.[ADV.ws.now] === ADV.ws.value && !(ADV.ws.old in (state?.workspace ?? {})), JSON.stringify(res.facts.advancedAfter))
      const old = await api(`/v1/settings/${encodeURIComponent(`advanced.${ADV.app.old}`)}`).catch((e) => ({ error: String(e) }))
      res.facts.advancedOldId = old
      // No aliases (SPEC, the cw. ids; HI-2598 dropped HI-2518's "renamed: use …"): the old id is answered as any id that isn't a setting.
      check('4.advanced-old-id', `An agent naming the old id (advanced.${ADV.app.old}) is told there is no such setting, its value not read`, typeof old?.error === 'string' && old.error.startsWith(`No setting "advanced.${ADV.app.old}"`) && !('value' in (old ?? {})), JSON.stringify(old))
    }
    await shot('after-upgrade-light')
    await theme('dark')
    await shot('after-upgrade-dark')
  }
}

;(async () => {
  try {
    if (!steps[step]) throw new Error(`unknown step ${step}`)
    if (step !== 'after-upgrade') res.facts.closedBefore = closeRunningApp()
    await steps[step]()
    res.completed = true
  } catch (e) {
    res.error = String(e.stack || e).slice(0, 2000)
    check(`${prefix}.error`, `${step}: no error`, false, res.error)
    if (page) await shot('error').catch(() => {})
    process.exitCode = 1
  } finally {
    if (app) {
      // Every settings change above waited for Combwork to save it (mark, theme), so it can close now.
      await app.close().catch(e => { res.closeError = String(e) })
    }
    save()
  }
})()
