// Shared helpers for Combwork's end-to-end suites (tests/e2e). They drive the real app with Playwright's
// _electron against a dev build (npx electron-vite build), in throwaway profiles and workspaces under
// WORK, and never touch the real Combwork profile, ~/.codex or the clipboard.
//
// Needs: the standalone Claude Code CLI (signed in) and, for the Codex suites, Codex signed in to the test
// home CODEX_HOME. The first Claude Code run in a test folder asks whether to trust it; acceptClaudeTrust
// answers that (it is not a sign-in screen). Suites never automate sign-in screens.
const fs = require('fs')
const path = require('path')
const { execFileSync, execSync } = require('child_process')
const { _electron } = require('playwright-core')

// The run context (runContext.cjs): the environments of everything a suite starts, its folders and the CLI test homes.
const { TEST_ROOT, WORK, CODEX_HOME, CLAUDE_TEST_HOME, hiveEnv, childEnv, baseEnv, isHiveEnv, isUserCliHome, trashDir, TEST_GIT_IDENTITY, gitConfig, writeGitConfig, gitEnv: contextGitEnv, isUserGitConfig } = require('./runContext.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
/** Electron's executable (the electron package resolves to its path in plain Node). */
const ELECTRON = require('electron')
const { windowsCodesIn } = require('./windowsExits.cjs')
const { readDocs, writeDoc } = require('./boardRows.cjs')
// WORK: where suites keep their profiles, workspaces and screenshots. Stable, so Claude Code trusts its folders once.
fs.mkdirSync(WORK, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A new folder for a probe of your own (a Playwright script's profile, workspace and screenshots; #304), in
 * hive-test\scratch, named for it and the time: `scratch\<name>-<yyyymmdd-hhmmss>-<random>`. Every run gets a new one,
 * so nothing needs deleting first (never `rm -rf` a computed path: Claude Code asks, and unattended it denies). The
 * clean-up prunes them after a few days (`npm run test:clean`), unless a card that isn't Done cites one.
 */
/**
 * Removes a folder a suite made outside the runner's (one the runner doesn't remove for it, e.g. update's download
 * cache) at its end, best effort (#324): a file a CLI or a scanner still holds for a moment after the test Combwork closed
 * is retried a few times, and one that still can't go is said in the log and left for the next run's clear, never
 * failing a suite whose checks passed. A suite's own folders in its lane need no removal at all: the runner removes them.
 */
function tidyUp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (e) {
    console.log(`(left ${dir} for the next run: ${e.code || e.message})`)
  }
}

/** The test copies' trash folder (#414): what they delete goes there, never to the user's Recycle Bin. */
const TRASH = trashDir()

/**
 * What the test copies of Combwork this suite started have deleted, oldest first: `{ at, from, to }` each (the original
 * path, and where it is now in TRASH). `match` keeps those whose original path contains it (any case, either slash).
 */
function trashed(match = '') {
  let lines = []
  try {
    lines = fs.readFileSync(path.join(TRASH, 'trash.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
  const norm = (p) => String(p).toLowerCase().replaceAll('/', path.sep)
  return lines.map((l) => JSON.parse(l)).filter((e) => norm(e.from).includes(norm(match)))
}

/**
 * A card of a workspace's board as Combwork saved it (in .combwork\hive.db: its JSON document, from 1.0's tables, #1209), read on a
 * connection of its own (read-only; Combwork writing meanwhile is fine). Throws when there is no such card.
 */
function readCard(ws, n) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(ws, '.combwork', 'hive.db'), { readOnly: true, timeout: 5000 })
  try {
    const [row] = readDocs(db, [n])
    if (!row) throw new Error(`no card #${n} in ${ws}`)
    return row.doc
  } finally {
    db.close()
  }
}

/** Saves a card's document as another program would (a running Combwork sees it within about a second, #1017). */
function writeCard(ws, n, doc) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(ws, '.combwork', 'hive.db'), { timeout: 5000 })
  try {
    writeDoc(db, n, doc)
  } finally {
    db.close()
  }
}

function probeDir(name = 'probe', root = TEST_ROOT) {
  const base = path.join(root, 'scratch')
  const label = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'probe'
  const d = new Date()
  const two = (n) => String(n).padStart(2, '0')
  // Local time, as the runs' log folders are named.
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, `${label}-${stamp}-`))
}
/**
 * A token in a file of its own, as Combwork gives a session its token (HI-2262: CW_API_TOKEN_FILE, never HIVE_API_TOKEN):
 * its path, for a child's CW_API_TOKEN_FILE. `dir`: where (a new probe folder by default).
 */
function tokenFile(token, dir = probeDir('token')) {
  const file = path.join(dir, `token-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  fs.writeFileSync(file, JSON.stringify({ token }))
  return file
}
/**
 * A suite's Agent API port, as a string: the runner's (HIVE_E2E_PORT, one per suite running at the same time, so suites
 * can run side by side), else the suite's own default when it runs alone (node tests/e2e/<suite>.cjs).
 */
const port = (fallback) => process.env.HIVE_E2E_PORT || String(fallback)

/** Waits until fn() returns something truthy (checking every interval ms), up to ms; returns its last value. */
async function until(fn, ms = 10000, interval = 100) {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await sleep(interval)
  return v
}

/**
 * Hovers `locator` and returns the text of the tooltip it shows, once `want(text)` holds (or the text shown after ms).
 * A tooltip shows after its delay (ui.tsx), measured hidden before it is placed, so this waits for it to be visible
 * with the text, never for the delay. The mouse first leaves for the window's corner, so an earlier tip has gone.
 */
async function hoverTip(page, locator, want, ms = 10000) {
  const tip = () => page.locator('.tip:visible').last().innerText({ timeout: 1000 }).catch(() => '')
  await page.mouse.move(5, 5)
  await until(async () => (await page.locator('.tip:visible').count()) === 0, ms)
  await locator.hover()
  return (await until(async () => { const t = await tip(); return want(t) && t }, ms)) || (await tip())
}

let quitWatches = 0
/**
 * Watches a test copy of Combwork quit, telling Combwork's part from the process's (#424). Start it before the quit.
 * `untilDecided(ms)`: the time Combwork called app.quit (or app.exit), recorded in main as it calls it: its own quit work is
 * done (sessions stopped, state saved), or null if it hasn't within ms. `gone(ms)`: the process has ended since. What
 * comes between (Electron closing windows and processes) is the machine's, and a loaded one stretches it to seconds, so
 * a suite times Combwork's part and only waits for the rest. `timings()` says both, for the suite's log.
 */
async function quitWatch(app) {
  const file = path.join(WORK, `quit-watch-${process.pid}-${++quitWatches}.txt`)
  fs.rmSync(file, { force: true })
  await app.evaluate(({ app: a }, f) => {
    const out = process.mainModule.require('fs')
    for (const name of ['quit', 'exit']) {
      const original = a[name].bind(a)
      a[name] = (...args) => {
        try {
          if (!out.existsSync(f)) out.writeFileSync(f, String(Date.now()))
        } catch {
          // The watch is the test's: a quit goes on without it.
        }
        return original(...args)
      }
    }
  }, file)
  const proc = app.process()
  let exitedAt = proc.exitCode !== null ? Date.now() : null
  const exited = exitedAt ? Promise.resolve() : new Promise((r) => proc.once('exit', () => r((exitedAt = Date.now()))))
  const decided = () => {
    try {
      return Number(fs.readFileSync(file, 'utf8')) || null
    } catch {
      return null
    }
  }
  return {
    untilDecided: (ms) => until(decided, ms),
    // Its timer goes once the process has ended, so a suite that has finished isn't kept alive for the rest of ms.
    gone: (ms) =>
      new Promise((resolve) => {
        if (exitedAt) return resolve(true)
        const timer = setTimeout(() => resolve(false), ms)
        void exited.then(() => {
          clearTimeout(timer)
          resolve(true)
        })
      }),
    timings: (from) => {
      const d = decided()
      return `Combwork's quit work ${d ? `${d - from} ms` : 'not done'}, the process gone ${d && exitedAt ? `${exitedAt - d} ms after` : exitedAt ? 'without it' : 'not yet'}`
    }
  }
}

/** Turns providers on in a test profile's config before Combwork starts (fresh profiles start with none). */
function enableProviders(userData, providers = ['claude-code']) {
  fs.mkdirSync(userData, { recursive: true })
  const file = path.join(userData, 'config.json')
  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // No config yet.
  }
  // A 0.1 config: the migration keeps Claude Code on.
  if ((cfg.version ?? 1) < 2 && fs.existsSync(file)) return
  cfg.version = 2
  cfg.settings = cfg.settings ?? {}
  cfg.settings.providers = cfg.settings.providers ?? {}
  // No online check for a newer CLI at every launch: slow, needs the network, and no suite is about it.
  for (const p of providers) cfg.settings.providers[p] = { checkUpdatesOnLaunch: false, ...cfg.settings.providers[p], enabled: true }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
}

/**
 * A Claude Code home of the suite's own for the real Claude Code (#345, #368): new each run in its folder, with Claude
 * Code's first-run onboarding done and a made-up API key approved (its own fields in .claude.json), so it starts at its
 * prompt with no sign-in, and never in the user's ~/.claude. The key is valid for nothing: a suite using it sends no
 * prompt, and no tokens are spent (one that sends prompts uses the signed-in CLAUDE_TEST_HOME, claudeHome: 'test', as
 * assistantresume does). Said in the log, so the run shows the home. Returns { home, env }: env ({ CLAUDE_CONFIG_DIR,
 * ANTHROPIC_API_KEY }) goes into hiveEnv.
 */
function ownClaudeHome(name) {
  const home = path.join(WORK, `${name}-claude-home`)
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  // Made up: shaped like an API key, valid for nothing.
  const apiKey = `sk-ant-api03-hivetest-${require('crypto').randomBytes(24).toString('hex')}`
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] } }))
  console.log(`Claude Code home: ${home} (CLAUDE_CONFIG_DIR, the suite's own; a made-up API key, no sign-in)`)
  return { home, env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: apiKey } }
}

/**
 * The fake Claude Code (fake-claude/) for a test profile, for a suite about Combwork's own behaviour that only needs some
 * session running (#194): turns Claude Code on in userData's config with the fake as its path, makes home a fresh
 * Claude Code config folder in which the fake trusts `trusted` (so it asks nothing), and returns the variables to start
 * Combwork with: { CLAUDE_CONFIG_DIR }. A config written before (a 0.1 one, settings of the suite's) is kept.
 */
function fakeClaude(userData, home, trusted = []) {
  enableProviders(userData)
  const file = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  cfg.settings = cfg.settings ?? {}
  cfg.settings.providers = cfg.settings.providers ?? {}
  cfg.settings.providers['claude-code'] = { checkUpdatesOnLaunch: false, ...cfg.settings.providers['claude-code'], executablePath: path.join(__dirname, 'fake-claude', 'fake-claude.cmd') }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'fake-trusted.json'), JSON.stringify(trusted.map((f) => f.toLowerCase())))
  // Its input log on, for typeLine (#1560).
  logFakeInput(home)
  return { CLAUDE_CONFIG_DIR: home }
}

/**
 * Sizes the test window's page area to `size` and pins the page to it. Pinning alone (setViewportSize) leaves
 * the rest of a bigger window blank, which looks like a layout bug when you watch a suite run.
 */
async function fitWindow(app, page, size) {
  await app
    .evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(w, h)
    }, [size.width, size.height])
    .catch(() => {})
  await page.setViewportSize(size).catch(() => {})
}

/**
 * Waits until Combwork's window has rendered with its settings loaded, and Combwork has finished looking for the providers'
 * CLIs (it does that in the background after start; starting an agent before then fails with "… is required").
 * Instead of a fixed wait after launch.
 */
async function appReady(page, ms = 90000) {
  const ready = () =>
    page
      .evaluate(async () => {
        if (!document.querySelector('.app .workbench')) return false
        const info = await window.combwork.invoke('provider:info')
        return Object.values(info).every((p) => !p.checking)
      })
      .catch(() => false)
  const ok = await until(ready, ms)
  if (!ok) throw new Error("Combwork's window wasn't ready (rendered, providers found) within " + ms / 1000 + ' s')
}

/** Opens a workspace and waits until the window shows it (its name in the title), instead of a fixed wait. */
async function openWorkspace(inv, page, ws, ms = 20000) {
  await inv('workspace:open', ws)
  const name = path.basename(ws)
  const ok = await until(() => page.evaluate((n) => document.title.includes(n), name).catch(() => false), ms)
  if (!ok) throw new Error(`The window didn't show the workspace ${name} within ${ms / 1000} s`)
}

/**
 * Starts the dev build with a test profile, or the packaged Combwork.exe HIVE_EXE names (the Sandbox upgrade checks run
 * boardupgrade and upgradelane against an installed build that way, #1227). Returns { app, page, inv } (inv calls an
 * IPC channel). readyMs bounds the wait for its window to be ready; one that isn't is closed and the failure thrown.
 */
async function launch({ userData, env = {}, viewport = { width: 1400, height: 850 }, readyMs = 90000 }) {
  const exe = process.env.HIVE_EXE
  if (exe && !launch.said) console.log(`Combwork: ${exe} (HIVE_EXE), not the dev build`)
  launch.said = !!exe
  // The run context's environment (quiet, tips off, the suite's port) with the profile and the suite's own variables.
  const app = await _electron.launch({ executablePath: exe || ELECTRON, args: exe ? [] : [ROOT], cwd: ROOT, env: hiveEnv({ HIVE_USER_DATA: userData, ...env }) }).catch((e) => {
    // Electron that failed to start (0xc0000142 under heavy load, #599): its exit code said with what it means.
    const said = windowsCodesIn(e?.message)
    if (said.length && e instanceof Error) e.message = `${e.message}\nWindows: ${said.join('; ')}`
    throw e
  })
  let page
  try {
    page = await app.firstWindow()
    await fitWindow(app, page, viewport)
    await appReady(page, readyMs)
  } catch (e) {
    // Started but never ready: it closes here, as no caller gets it to close (#464); its own failure is the one thrown.
    await app.close().catch(() => undefined)
    throw e
  }
  const inv = (ch, ...a) => page.evaluate(([c, args]) => window.combwork.invoke(c, ...args), [ch, a])
  return { app, page, inv }
}

/**
 * Waits until Combwork has finished looking for a provider's CLI (it does so in the background after start): starting
 * an agent before then fails with "Claude Code is required". Throws if it isn't found.
 */
async function waitForProvider(inv, provider = 'claude-code', timeoutMs = 60000) {
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    const info = (await inv('provider:info').catch(() => ({})))[provider]
    if (info && !info.checking) {
      if (!info.found) throw new Error(`${provider} wasn't found on this machine`)
      return info
    }
    await sleep(250)
  }
  throw new Error(`${provider}: still looking for it after ${timeoutMs / 1000} s`)
}

/** What a connection sets, by the name an agent's own settings had before HI-2122 (the launch values). */
const LAUNCH_KEYS = ['model', 'effort', 'permissionMode', 'use200kContext', 'extraArgs']

/**
 * Adds an agent (Claude Code in the project folder unless told otherwise); returns its definition. One in a worktree of
 * its own (`location`: new-worktree or existing-worktree) is a 0.9 agent, as an upgraded project has one: 1.0 adds none
 * (#1451), so the test copies' channel makes it (`agents:testLegacy`). A model, effort, permission mode, 200K context or
 * extra arguments given are its connection's since HI-2122 (an agent has none of its own): it gets the connection on its
 * account with them (setLaunch).
 */
async function addAgent(inv, proj, opts = {}) {
  const legacy = opts.location === 'new-worktree' || opts.location === 'existing-worktree'
  const values = Object.fromEntries(LAUNCH_KEYS.filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]))
  const rest = Object.fromEntries(Object.entries(opts).filter(([k]) => !LAUNCH_KEYS.includes(k)))
  const def = await inv(legacy ? 'agents:testLegacy' : 'agents:add', proj, { location: 'project', provider: 'claude-code', ...rest })
  return Object.values(values).some((v) => v !== '' && v !== null && v !== false) ? setLaunch(inv, proj, def.id, values) : def
}

/**
 * Gives an agent a model, effort, permission mode, 200K context or extra arguments (HI-2122: they are its connection's):
 * the connection on its account with its current connection's values and these over them ('' or null: the CLI's own),
 * one already there if any, else one made (connection:add, as the connection dialog makes it); then the agent is
 * pointed at it. Returns the agent as saved. Its CLI must have an account here (a test home's counts).
 */
async function setLaunch(inv, proj, agentId, values) {
  // Anything else (a provider: HI-2210) would be dropped unseen, leaving the agent on its account's CLI.
  const other = Object.keys(values).filter((k) => !LAUNCH_KEYS.includes(k))
  if (other.length) throw new Error(`setLaunch: not launch values: ${other.join(', ')} (change an agent's CLI with agents:update first)`)
  const rows = (await inv('connections:list')).connectionRows
  const agent = savedAgents(proj).find((a) => a.id === agentId)
  const current = rows.find((c) => c.id === agent?.connection)
  if (!current) throw new Error(`setLaunch: ${agentId} has no connection to start from (saved: ${JSON.stringify(agent ?? null)})`)
  const next = Object.fromEntries(LAUNCH_KEYS.filter((k) => current[k] !== undefined).map((k) => [k, current[k]]))
  for (const [k, v] of Object.entries(values)) {
    if (v === '' || v === null || v === undefined || v === false || v === 'inherit') delete next[k]
    else next[k] = v
  }
  const same = (c) => LAUNCH_KEYS.every((k) => (c[k] ?? null) === (next[k] ?? null))
  let target = rows.find((c) => c.account === current.account && same(c))
  if (!target) {
    const taken = new Set(rows.filter((c) => c.account === current.account).map((c) => c.name.toLowerCase()))
    const label = LAUNCH_KEYS.filter((k) => next[k] !== undefined).map((k) => (next[k] === true ? '200K' : String(next[k]))).join(' · ') || 'CLI defaults'
    let name = `Test · ${label}`
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Test · ${label} (${n})`
    target = await inv('connection:add', current.account, { name, ...Object.fromEntries(LAUNCH_KEYS.map((k) => [k, next[k] ?? null])) })
  }
  return inv('agents:update', proj, agentId, { connection: target.id })
}

/**
 * setLaunch for each of a project's agents on one CLI, as Project Settings' provider page did before HI-2122: there are
 * no project-wide launch values, only each agent's connection.
 */
async function setProjectLaunch(inv, proj, provider, values) {
  for (const a of savedAgents(proj)) if (a.provider === provider) await setLaunch(inv, proj, a.id, values)
}

/**
 * A project's agents (or the Assistant home's) as saved in its project.json, which agents:add and agents:update have
 * written by the time they answer (HI-2249). Never a workspace:refresh: a refresh that read a project before a later
 * write to it (the accounts migration's at a workspace's open, HI-2106) answers with the refresh before it (#999), from
 * before an agent just added was there, or with its connection before a change.
 */
function savedAgents(proj) {
  return JSON.parse(fs.readFileSync(path.join(proj, '.combwork', 'project.json'), 'utf8')).agents ?? []
}

/** Makes a project's only agent (removing any others first): for suites that reuse a workspace. */
async function soloAgent(inv, proj, opts = {}) {
  await inv('project:updateConfig', proj, { agents: [] })
  return addAgent(inv, proj, opts)
}

/** Terminal key of an agent's session. */
const ptyKey = (proj, agentId) => `session:${proj.toLowerCase()}#${agentId}`

/**
 * Claude Code at its prompt, past its first-run questions: its footer, "? for shortcuts" before 2.1.289 and the mode
 * line since ("⏵⏵ auto mode on (shift+tab to cycle)", "⏸ manual mode on"). The trust and import screens show neither.
 */
const CLAUDE_AT_PROMPT = /for shortcuts|\? for|shift\+tab to cycle|\bmode on\b/i

/**
 * Answers Claude Code's "trust this folder" question in an agent's terminal, if it asks: true when it answered, false
 * as soon as the session is past it (Claude Code's prompt on screen, or Combwork has the session ready: a trusted folder
 * asks nothing, #188), or at the timeout. Never answers anything else (a sign-in screen least of all).
 */
async function acceptClaudeTrust(inv, proj, agentId, timeoutMs = 15000) {
  const key = ptyKey(proj, agentId)
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    // Terminal UIs draw spaces as cursor moves: control sequences become spaces before matching.
    const text = plainText(await inv('pty:buffer', key).catch(() => ''))
    if (/trust this folder/i.test(text)) return chooseTrust(inv, key, Math.max(3000, timeoutMs - (Date.now() - t)))
    if (CLAUDE_AT_PROMPT.test(text)) return false
    const live = (await inv('session:live').catch(() => [])).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agentId)
    if (live?.status === 'ready') return false
    await sleep(500)
  }
  return false
}

/**
 * After a restart: answers the relaunch's trust question (acceptClaudeTrust), but only once `spawned()` says its new
 * process runs (within spawnMs): until then the terminal still holds the previous process's screen, its question too,
 * so nothing is read or typed there (#341). { spawned, trusted }: spawned false when the new process wasn't seen.
 */
async function acceptRelaunchTrust(inv, proj, agentId, spawned, { spawnMs = 20000, timeoutMs = 30000 } = {}) {
  if (!(await until(spawned, spawnMs))) return { spawned: false, trusted: false }
  return { spawned: true, trusted: await acceptClaudeTrust(inv, proj, agentId, timeoutMs) }
}

/** The trust question's choice the terminal shows selected last ('No, exit' or 'Yes, …'), or null. */
function trustChoice(text) {
  const marks = [...plainText(text).matchAll(/[>❯›]\s*(?:\d\.\s*)?(No, exit|Yes, I trust this folder)/g)]
  return marks.length ? marks.at(-1)[1] : null
}

/**
 * Says yes to Claude Code's trust question. Its menu starts on "No, exit", and Enter on that quits Claude Code (exit 1).
 * A key sent while it is still drawing the menu is dropped on a busy machine (#218: Down lost, Enter chose No), so
 * Enter is pressed only once the terminal shows "Yes" selected, Down sent again until it does; never on "No". true when
 * it answered yes.
 */
async function chooseTrust(inv, key, timeoutMs = 20000) {
  const t = Date.now()
  const choice = async () => trustChoice(await inv('pty:buffer', key).catch(() => ''))
  while (Date.now() - t < timeoutMs) {
    // Still "Yes" a moment later: a Down still on its way would have moved it back by then.
    if ((await choice()) === 'Yes, I trust this folder' && (await sleep(400), (await choice()) === 'Yes, I trust this folder')) {
      await inv('pty:write', key, '\r')
      return true
    }
    await inv('pty:write', key, '\x1b[B')
    // A try's pace, not a bound: not on "Yes" within 2 s, Down is pressed again (timeoutMs bounds the whole).
    await until(async () => (await choice()) === 'Yes, I trust this folder', 2000, 150)
  }
  return false
}

/**
 * Runs fn holding a lock beside file (`<file>.lock`, a folder: creating one is atomic), for a change that reads the file
 * and writes it back: runners in different worktrees share the Codex test home (e2e lanes don't split it: it holds the
 * one sign-in), and two changes at once would otherwise lose one. A lock older than staleMs was left by a crash.
 *
 * On Windows the lock folder can't always be made or removed the moment another runner lets go of it: while something
 * still has it open (another runner looking at its age, a virus scan), creating it says EPERM, EACCES or EBUSY rather
 * than EEXIST, and removing it fails the same way. Both mean busy, not broken (#181): taking the lock waits as for
 * EEXIST (a real permission problem still ends at timeoutMs, naming the error), and letting go tries again for a moment
 * rather than failing a runner whose change is already written.
 */
function withFileLock(file, fn, { staleMs = 30_000, timeoutMs = 120_000 } = {}) {
  const lock = `${file}.lock`
  const start = Date.now()
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      if (!LOCK_BUSY.has(e.code)) throw e
      if (Date.now() - start > timeoutMs) throw new Error(`${lock} is still held (${e.code})`, { cause: e })
      let age
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs
      } catch {
        // EEXIST and now gone: just released, try again at once. Refused (in use) and its age unreadable: wait as
        // for a held lock, so a lasting refusal is a slow poll until the timeout, never a busy loop (review #181).
        if (e.code !== 'EEXIST') pause(25)
        continue
      }
      if (age > staleMs) removeLock(lock, pause)
      else pause(25)
    }
  }
  try {
    return fn()
  } finally {
    removeLock(lock, pause)
  }
}
/** What creating or removing a lock folder says while another process still has it open (Windows), or while it exists. */
const LOCK_BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])
/** Removes a lock folder, trying again for up to a second while Windows says it is in use; gone already is fine. */
function removeLock(lock, pause) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(lock, { recursive: true, force: true })
      return
    } catch (e) {
      if (!LOCK_BUSY.has(e.code) || attempt >= 40) throw e
      pause(25)
    }
  }
}

/**
 * Trusts a folder in the test Codex home (and makes sure its non-admin sandbox is set). Under withFileLock: suites of
 * runners in different lanes trust their own folders in the same config.toml.
 */
function trustForCodex(folder, home = CODEX_HOME) {
  fs.mkdirSync(home, { recursive: true })
  const cfg = path.join(home, 'config.toml')
  withFileLock(cfg, () => {
    const before = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : ''
    let t = before
    if (!t.includes(`[projects.'${folder}']`)) t += `\n[projects.'${folder}']\ntrust_level = "trusted"\n`
    if (!/^\[windows\]/m.test(t)) t += `\n[windows]\nsandbox = "unelevated"\n`
    if (t !== before) fs.writeFileSync(cfg, t)
  })
}

/**
 * Failures that come from the machine, not from Combwork: the CLI's usage or rate limit, its sign-in, the network to its
 * API. Matched in the CLI's own output (terminal text, a session's status message), conservatively: anything not
 * clearly one of these stays a FAIL. Hook errors (127.0.0.1) are Combwork's, never the environment's.
 */
const ENVIRONMENT = [
  { why: 'usage or rate limit', re: /(?:usage|5-hour|weekly|session|opus|sonnet) limit reached|hit your (?:usage )?limit|rate_limit_error|rate limit(?:ed| exceeded)|too many requests|API Error: 429/i },
  { why: 'the API is overloaded', re: /overloaded_error|API Error: 529/i },
  { why: 'not signed in', re: /select login method|please run \/login|not logged in|invalid api key|oauth token (?:has )?expired|oauth session expired|authentication_error|sign in with chatgpt|run `?codex login/i },
  { why: 'network', re: /API Error: (?:Connection error|Request timed out)|unable to connect to (?:the )?(?:Anthropic )?API|stream disconnected before completion|error sending request for url \(https:\/\/[\w.]*(?:openai|chatgpt)|ENOTFOUND [\w.]*(?:anthropic|openai|chatgpt)/i }
]
/** Terminal text as plain words: control sequences become spaces, runs of space one. */
const plainText = (s) =>
  String(s ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b\][^\x07]*\x07/g, ' ')
    .replace(/\s+/g, ' ')

/** Every environment failure in this CLI output, in order: [{ why, at }] ("usage or rate limit: …", with what it said). */
function environmentProblems(text) {
  const t = plainText(text)
  const found = []
  for (const { why, re } of ENVIRONMENT)
    for (const m of t.matchAll(new RegExp(re.source, 'gi'))) {
      const from = Math.max(0, m.index - 20)
      found.push({ why: `${why}: …${t.slice(from, m.index + m[0].length + 40).trim()}…`, at: m.index })
    }
  return found.sort((a, b) => a.at - b.at)
}

/** Why this CLI output shows a failure of the environment, or null (the first one). */
const environmentProblem = (text) => environmentProblems(text)[0]?.why ?? null

/**
 * Codex's Windows sandbox can't start the Microsoft Store's PowerShell 7 while any other process of that package runs
 * on the machine, sandboxed or not (#499, #658): an agent's PowerShell command, a pwsh terminal. A launch it refused,
 * only as Codex's transcript records the command's end (its terminal cuts the command off; a message quoting the
 * error, or a command's output, is no launch): an `item_completed` event of a CommandExecution that failed with exit
 * code -1, whose executable (command[0], and the cmd= its output names) is the Store's pwsh, by its WindowsApps alias
 * or the package's own path, and whose output is the refusal, error 5 or 0xC0070005. Any other record, code or shell
 * (Windows PowerShell, cmd, an installed PowerShell 7) is not this, and stays a FAIL. As Codex 0.162 writes it.
 */
const STORE_PWSH_REFUSED = /^Failed to create unified exec process: CreateProcessAsUserW failed: (5 \(Access is denied\.\)|-1073283067)(?![\d.]) \| cwd=[^|]*\| cmd=(?:"([^"]+)"|(\S+))/
const STORE_PWSH = [/\\Microsoft\\WindowsApps\\pwsh\.exe$/i, /\\WindowsApps\\Microsoft\.PowerShell_[^\\]+\\pwsh\.exe$/i]

/** The Store PowerShell launches Codex's sandbox refused in this transcript (a rollout's JSON lines): [{ why, at }]. */
function storePwshRefusals(jsonl) {
  const found = []
  const seen = new Set()
  String(jsonl ?? '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.includes('CreateProcessAsUserW')) return
      let record
      try {
        record = JSON.parse(line)
      } catch {
        return
      }
      const item = record?.type === 'event_msg' && record.payload?.type === 'item_completed' ? record.payload.item : null
      if (item?.type !== 'CommandExecution' || item.status !== 'failed' || item.exit_code !== -1 || typeof item.aggregated_output !== 'string') return
      const exe = Array.isArray(item.command) && typeof item.command[0] === 'string' ? item.command[0] : ''
      const m = STORE_PWSH_REFUSED.exec(item.aggregated_output)
      if (!m || (m[2] ?? m[3]).toLowerCase() !== exe.toLowerCase() || !STORE_PWSH.some((re) => re.test(exe))) return
      if (item.id && seen.has(item.id)) return
      seen.add(item.id)
      found.push({ why: `Codex's sandbox couldn't start the Store PowerShell 7 while another of its processes ran (#499, #585): ${m[1]}, ${exe}`, at: i })
    })
  return found
}

/** A transcript's text, or '' (none yet, or unreadable). */
function transcriptText(file) {
  try {
    return file ? fs.readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

// Every Combwork a suite starts, whether through launch() or Playwright's _electron.launch directly (most suites do that):
// require('playwright-core') is one module, so suites get this _electron. cliStep reads their sessions. Each must have
// the run context's environment (hiveEnv): without one, Playwright would pass on the suite's own.
const apps = new Set()
const launchElectron = _electron.launch.bind(_electron)
_electron.launch = async (...args) => {
  const env = args[0]?.env
  if (!isHiveEnv(env)) throw new Error("Start a test Combwork with lib.hiveEnv({ HIVE_USER_DATA, … }) as its env (tests/e2e/runContext.cjs), never the suite's own environment")
  // The CLI homes, test folders (#382, #452): Combwork looks for the CLIs when it starts, and their sign-in checks read these.
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GH_CONFIG_DIR']) {
    if (!env[k]) throw new Error(`A test Combwork needs ${k} (hiveEnv gives an empty one of the suite's; a suite may give a test home, never none): without it the CLI reads the user's own home (#382)`)
    if (isUserCliHome(env[k])) throw new Error(`A test Combwork's ${k} is the user's own home (${env[k]}): give it a test home (#382)`)
    // The suite's empty one is made here (Codex refuses a CODEX_HOME that doesn't exist).
    fs.mkdirSync(env[k], { recursive: true })
  }
  // Its git's global config, the suite's (#1466): without one its git reads the user's ~/.gitconfig, and the user's name
  // and email show in its screens. The work folder's is written here, with the test identity.
  if (!env.GIT_CONFIG_GLOBAL) throw new Error("A test Combwork needs GIT_CONFIG_GLOBAL (hiveEnv gives the suite's, with a test identity): without it its git reads the user's ~/.gitconfig (#1466)")
  if (isUserGitConfig(env.GIT_CONFIG_GLOBAL)) throw new Error(`A test Combwork's GIT_CONFIG_GLOBAL is the user's own (${env.GIT_CONFIG_GLOBAL}): give it the suite's (#1466)`)
  if (env.GIT_CONFIG_GLOBAL === gitConfig()) writeGitConfig(env.GIT_CONFIG_GLOBAL)
  const packaged = testExecutable(args[0].executablePath ?? ELECTRON) === 'packaged'
  // Its profile on its command line (#614), which Combwork ignores: the runner stops what names a suite's folder once the
  // suite ends, and a test Combwork's own line names only the checkout, so a suite killed before closing its Combwork (HB1's,
  // 10 Oct) left it running for a day. Chromium's own processes already name it (--user-data-dir).
  if (env.HIVE_USER_DATA) args[0] = { ...args[0], args: [...(args[0].args ?? []), `--hive-test-profile=${env.HIVE_USER_DATA}`] }
  if (packaged) {
    args[0] = { ...args[0], args: [...args[0].args, ...PACKAGED_ARGS], env: { ...env, ...NO_UPDATE_CHECK } }
    unmaximized(env.HIVE_USER_DATA)
    noUpdateChecks(env.HIVE_USER_DATA)
    if (env.HIVE_USER_DATA) packagedLaunches.push({ profile: env.HIVE_USER_DATA, since: new Date().toISOString() })
  }
  const from = Date.now()
  const app = await launchElectron(...args)
  // An app.evaluate reaches main through Node's inspector, which runs it at once even while main's JS is running: in a
  // V8 interrupt, in the middle of whatever main was doing. A function that calls into Combwork (a window event, a setting)
  // then changes Node's timer queue while main is half way through changing it, which breaks the queue for good (#997:
  // "reading 'expiry'" from ConfigStore.scheduleSave's clearTimeout under load, and every save after it failed). So
  // each runs after an await: V8 queues the rest, which runs once the code it interrupted has finished. Not
  // setImmediate or queueMicrotask: they are Node's own JS, changing queues the interrupted code may be changing.
  const evaluate = app.evaluate.bind(app)
  app.evaluate = (fn, arg) =>
    evaluate(
      async (modules, [source, a]) => {
        await undefined
        // eslint-disable-next-line eslint/no-eval -- the suite's own function, as Playwright would have run it (in main's global scope)
        return (0, eval)(`(${source})`)(modules, a)
      },
      [String(fn), arg]
    )
  apps.add(app)
  app.on('close', () => apps.delete(app))
  watchCommitBursts(app)
  if (packaged) {
    const shown = await app.evaluate(keepPackagedQuiet).catch((e) => ({ error: e.message }))
    if (!Array.isArray(shown) || shown.length) {
      await app.close().catch(() => undefined)
      throw new Error(`A packaged test Combwork (${args[0].executablePath}) couldn't be kept off the screen (#1253): ${Array.isArray(shown) ? `its windows were shown before it was reached (${shown.join(', ')})` : shown.error}`)
    }
  }
  // Recorded by its pid and when it started (HI-1453), in the folder its runner gave the suite: whatever ends the run, the
  // runner ends each copy still running once the suite has ended, and the next run's start those an earlier run left.
  // Its main process's own pid: Playwright starts Electron through `cmd.exe /c` on Windows, so app.process() is that
  // shell, which ends with a killed suite while Combwork runs on outside the suite's job (how one ran 12 h): the shell's
  // child, by the process tree alone, trusted only while this process holds the shell's handle (it hasn't exited). Looked
  // up in the background, so the launch returns as it did: only a record, which never fails or holds up the suite. A
  // copy whose record isn't made (in time, or at all) is never ended by the runner, only listed.
  if (process.env.HIVE_E2E_DIR) recordMainProcess(WORK, app.process(), from, env.HIVE_USER_DATA ?? null).catch(() => undefined)
  return app
}

// React's commits in the suite's test copies (HI-1387, HI-1865). Each window of a test copy says each new largest burst
// on its console (src/shared/commitWatch.ts: `<marker> <n>`, n commits within 250 ms), small ones too, and each new
// longest commit chain (commits with nothing from outside between them: a setState-in-useEffect loop's shape). The
// suite's largest of each is said once as it exits, for the run's output (run.mjs), and once at the time it first
// reaches React's nested-update limit. The burst is recorded only: input makes bursts as large as a loop's (HI-1864).
// The chain fails the suite at the limit (HI-1865: a full run's normal suites stayed at 8 or under), unless the suite
// accepts its chain (acceptCommitChain: commitburst's deliberate loop).
const COMMIT_BURST_MARKER = '[hive commit burst]'
const COMMIT_CHAIN_MARKER = '[hive commit chain]'
const COMMIT_BURST_LIMIT = 50
/**
 * A suite's record of its windows' bursts: each window's own largest, from its console lines and read once from the page
 * as it is watched (one said before the listener was there isn't said again); the suite's, the largest of them, null
 * while no window has reported (no watch there, which isn't a burst of 0). onFirst: once, when the first window
 * reports; onReach(n): once, when the suite's first reaches the limit. Never throws into the suite: only a record.
 * marker and read: the count's console marker and its field in the page's `__hiveCommitBurst()` (the chain's: HI-1865).
 */
function burstWatcher({ onFirst = () => {}, onReach = () => {}, marker = COMMIT_BURST_MARKER, read = 'max' } = {}) {
  const perWindow = new Map()
  let largest = null
  const note = (page, n) => {
    if (!Number.isInteger(n) || n < 0 || n <= (perWindow.get(page) ?? -1)) return
    perWindow.set(page, n)
    const before = largest
    if (before !== null && n <= before) return
    largest = n
    if (before === null) onFirst()
    if ((before ?? -1) < COMMIT_BURST_LIMIT && n >= COMMIT_BURST_LIMIT) onReach(n)
  }
  const fromText = (text) => {
    const s = String(text)
    if (!s.startsWith(marker)) return null
    const n = Number(s.slice(marker.length).trim())
    return Number.isInteger(n) ? n : null
  }
  const watch = (page) => {
    try {
      page.on('console', (m) => {
        try {
          const n = fromText(m.text())
          if (n !== null) note(page, n)
        } catch {
          // Only a record: never the suite's failure.
        }
      })
    } catch {
      // As above.
    }
    // What the page reached before the listener was there: its own count, read once.
    try {
      Promise.resolve(page.evaluate((field) => window.__hiveCommitBurst?.()[field], read)).then(
        (n) => {
          if (typeof n === 'number') note(page, n)
        },
        () => undefined
      )
    } catch {
      // As above.
    }
  }
  return {
    watch,
    watchApp(app) {
      try {
        for (const page of app.windows()) watch(page)
        app.on('window', watch)
      } catch {
        // As above.
      }
    },
    largest: () => largest,
    windows: () => [...perWindow.values()]
  }
}
const bursts = burstWatcher({
  onFirst: () => process.once('exit', () => console.log(`INFO React commit burst: the largest was ${bursts.largest()} commits within 250 ms (recorded only: a suite fails on its commit chain, HI-1865)`)),
  onReach: (n) => console.log(`INFO React commit burst: ${n} commits within 250 ms, React's nested-update limit: recorded only (a suite fails on its commit chain, HI-1865)`)
})
/** Why the suite's commit chain at the limit is expected (acceptCommitChain), or null: then the chain fails it. */
let chainAccepted = null
const chains = burstWatcher({
  marker: COMMIT_CHAIN_MARKER,
  read: 'chain',
  onFirst: () => process.once('exit', chainVerdict),
  onReach: (n) => console.log(`INFO React commit chain: ${n} commits with nothing from outside between them, React's nested-update limit: the suite fails as it exits unless it accepts its chain (HI-1865)`)
})
/**
 * The suite's commit chain, as it exits (HI-1865): its longest, said; at React's nested-update limit, a FAIL line and
 * exit code 1 (an exit listener sets it even after the suite's own process.exit(0)), unless the suite accepted it.
 */
function chainVerdict() {
  const n = chains.largest()
  if (n < COMMIT_BURST_LIMIT) return console.log(`INFO React commit chain: the longest was ${n} commits with nothing from outside between them (a suite fails at ${COMMIT_BURST_LIMIT}, React's nested-update limit, HI-1865)`)
  if (chainAccepted !== null) return console.log(`INFO React commit chain: the longest was ${n} commits with nothing from outside between them, at React's nested-update limit (${COMMIT_BURST_LIMIT}), accepted by the suite: ${chainAccepted} (HI-1865)`)
  console.log(`FAIL React commit chain: the longest was ${n} commits with nothing from outside between them, at React's nested-update limit (${COMMIT_BURST_LIMIT}): a render loop, such as a setState per commit in a useEffect (#1366, HI-1865)`)
  process.exitCode = 1
}
/** A suite whose test copies make a chain at the limit on purpose (commitburst's loop) says so, and why: it doesn't fail. */
const acceptCommitChain = (why) => {
  if (typeof why !== 'string' || !why.trim()) throw new Error('acceptCommitChain needs the reason the chain is expected')
  chainAccepted = why
}
/** The suite's largest burst so far (0 while no window has reported). */
const commitBursts = () => bursts.largest() ?? 0
/** The suite's longest commit chain so far (0 while no window has reported). */
const commitChains = () => chains.largest() ?? 0
const watchCommitBursts = (app) => {
  bursts.watchApp(app)
  chains.watchApp(app)
}

/**
 * The copies a suite may never start (#1253): the installed app (the one hosting the agents, with its own profile and app
 * ID), Combwork's (HI-2460) and Hive Desktop's from before.
 */
const INSTALLED = ['Combwork', 'Hive'].flatMap((n) => [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', n), path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', n)])
/** This checkout's packaged build's executable (npm run dist): Combwork.exe since HI-2460. */
const PACKAGED_EXE = path.join(ROOT, 'dist', 'win-unpacked', 'Combwork.exe')
/** A folder's path as compared: real (a junction resolved), lower case, no trailing separator. */
const comparable = (p) => {
  let real = path.resolve(p)
  try {
    real = fs.realpathSync.native(real)
  } catch {
    // Not there (yet): its path as given.
  }
  return real.replace(/[\\/]+$/, '').toLowerCase()
}
const inside = (file, dir) => {
  const [f, d] = [comparable(file), comparable(dir)]
  return f === d || f.startsWith(d + path.sep)
}

/**
 * Which Combwork a suite starts: 'dev' (this checkout's Electron, the dev build) or 'packaged' (a Combwork.exe: this checkout's
 * dist\win-unpacked, the main checkout's 0.9 one boardupgrade and upgradelane use, one in the test folders, or what
 * HIVE_E2E_HIVE09 or HIVE_EXE name). Never the installed Combwork, nor one from anywhere else (#1253): it would open the user's
 * app on their screen. Throws for those.
 */
function testExecutable(exe) {
  if (comparable(exe) === comparable(ELECTRON)) return 'dev'
  if (INSTALLED.some((d) => d && inside(exe, d))) throw new Error(`A test may never start the installed Combwork (${exe}): use this checkout's build, or a 0.9 build's win-unpacked folder (HIVE_E2E_HIVE09) (#1253)`)
  const named = [ROOT, TEST_ROOT, process.env.HIVE_E2E_HIVE09, process.env.HIVE_EXE && path.dirname(process.env.HIVE_EXE)].filter(Boolean)
  if (named.some((d) => inside(exe, d))) return 'packaged'
  // Asked of git only now: in Windows Sandbox the checkout is a mapped copy, not a repository (#1227).
  const main = /^worktree (.+)$/m.exec(git(ROOT, 'worktree list --porcelain'))?.[1]
  if (!main || !inside(exe, path.join(main, 'dist', 'win-unpacked'))) throw new Error(`A test starts Combwork from this checkout, its dist, the main checkout's dist\\win-unpacked or the test folders, never ${exe} (#1253)`)
  return 'packaged'
}

/**
 * What a packaged test Combwork starts with (#1253): --hidden (Combwork makes its windows but never shows them, as when started at
 * sign-in: 0.9 too), so nothing is on screen before keepPackagedQuiet reaches it; and Chromium's occlusion tracking off,
 * so its windows, once shown off screen, still draw (main does that itself for a quiet copy).
 */
const PACKAGED_ARGS = ['--hidden', '--disable-features=CalculateNativeWinOcclusion']

/**
 * A profile saved with its window maximised: Combwork would maximise it as it starts, and maximising shows a hidden window.
 * A packaged test Combwork's profile is set not to (#1253). Kept files' copies (.bak) are left: config.json is read first.
 */
function unmaximized(profile) {
  const file = profile && path.join(profile, 'config.json')
  if (!file || !fs.existsSync(file)) return
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!cfg.window?.maximized) return
    cfg.window.maximized = false
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  } catch {
    // Unreadable: Combwork starts with its defaults.
  }
}

/**
 * A packaged test Combwork never checks GitHub for updates (#1332): each check fetches the release's latest.yml, which
 * GitHub counts as a download. 1.0 doesn't for HIVE_TEST_QUIET=1 (hiveEnv); a released build (0.9) can't be changed, so
 * its first check, 30 s after it starts, is put off as far as a timer goes (about 24.8 days: HIVE_UPDATE_DELAY, which
 * every build reads), and a profile it has saved has automatic checks off, so it schedules no 6-hourly check either.
 */
const NO_UPDATE_CHECK = { HIVE_UPDATE_DELAY: String(2 ** 31 - 1) }
function noUpdateChecks(profile) {
  const file = profile && path.join(profile, 'config.json')
  // A new profile is left alone: a config.json of settings alone would read as one from before every migration.
  if (!file || !fs.existsSync(file)) return
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (cfg.settings?.updates?.checkAutomatically === false) return
    cfg.settings = { ...cfg.settings, updates: { ...cfg.settings?.updates, checkAutomatically: false } }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  } catch {
    // Unreadable: Combwork starts with its defaults, and HIVE_UPDATE_DELAY still puts its check off.
  }
}

/**
 * The guard (#1332): when a suite ends, the log of each packaged Combwork it started (hive.log and its older copy) must show
 * no update check since that launch (electron-updater's "Checking for update", in Combwork's [updates] scope), or the suite
 * fails, whatever it said.
 */
const packagedLaunches = []
function updateChecksLogged({ profile, since }) {
  const found = []
  for (const name of ['hive.1.log', 'hive.log']) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(profile, 'logs', name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) if (line.slice(0, 24) >= since && /\[updates\] Checking for update/.test(line)) found.push(line.trim())
  }
  return found
}
process.on('exit', () => {
  const found = packagedLaunches.flatMap(updateChecksLogged)
  if (!found.length) return
  console.error(`FAILED: a packaged test Combwork checked GitHub for updates (#1332):\n${found.join('\n')}`)
  process.exitCode = 1
})

/**
 * Run in a packaged test Combwork's main process as soon as Playwright reaches it (#1253), making it quiet from outside, as
 * a dev test copy is from inside (testQuiet): a released build can't be changed, and isn't quiet. Its windows go off
 * screen (kept there however they're moved), unfocusable and off the taskbar, then are shown without taking the focus
 * (they draw, for screenshots); a window shown, focused, maximised, raised or flashed later stays off screen; Windows
 * notifications aren't shown, and its message boxes answer as cancelled. Returns the titles of the windows already shown
 * when it was reached: none, or the launch fails.
 */
function keepPackagedQuiet(electron) {
  const { app, BrowserWindow, Notification, dialog } = electron
  const shown = BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.getTitle() || 'untitled')
  // Electron's screen only once a window is made: Playwright can reach main before the app is ready, when screen isn't
  // usable yet (it threw inside 0.9's window's constructor, and no window was made).
  const displays = () => electron.screen.getAllDisplays().map((d) => d.bounds)
  const onScreen = (b) => displays().some((d) => b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y)
  const proto = BrowserWindow.prototype
  const showInactive = proto.showInactive
  const quiet = (win) => {
    if (win.isDestroyed() || win.hiveTestQuiet) return
    win.hiveTestQuiet = true
    const away = () => {
      if (win.isDestroyed()) return
      const b = win.getBounds()
      if (onScreen(b)) win.setPosition(Math.min(...displays().map((d) => d.x)) - b.width - 8000, Math.min(...displays().map((d) => d.y)))
    }
    away()
    win.setFocusable(false)
    win.setSkipTaskbar(true)
    win.on('move', away)
    win.on('resize', away)
  }
  proto.show = proto.showInactive = function () {
    quiet(this)
    showInactive.call(this)
  }
  for (const m of ['focus', 'maximize', 'moveTop', 'flashFrame', 'setAlwaysOnTop']) proto[m] = () => undefined
  Notification.prototype.show = () => undefined
  const answer = (a, b) => (b ?? a)?.cancelId ?? 0
  dialog.showMessageBox = async (a, b) => ({ response: answer(a, b), checkboxChecked: false })
  dialog.showMessageBoxSync = answer
  dialog.showErrorBox = () => undefined
  // One made later, hidden too (--hidden), is shown once it has drawn, as Combwork shows its own.
  app.on('browser-window-created', (_e, win) => {
    quiet(win)
    win.once('ready-to-show', () => win.isDestroyed() || showInactive.call(win))
  })
  for (const win of BrowserWindow.getAllWindows()) {
    quiet(win)
    showInactive.call(win)
  }
  return shown
}

/**
 * The environment failures in each session of the running test copies: Map<pty key, problems> (its terminal and status,
 * and the launches Codex's sandbox refused as its running session's transcript records them).
 */
async function sessionProblems() {
  const out = new Map()
  for (const app of apps)
    for (const page of app.windows()) {
      const texts = await page
        .evaluate(async () => {
          const ws = await window.combwork.invoke('workspace:get')
          const hosts = ws ? [...ws.projects, ...(ws.assistant ? [ws.assistant] : [])] : []
          const live = await window.combwork.invoke('session:live').catch(() => [])
          const found = []
          for (const h of hosts) {
            let records = null
            for (const a of h.agents ?? []) {
              const key = `session:${h.path.toLowerCase()}#${a.id}`
              const sessionId = live.find((s) => s.projectPath.toLowerCase() === h.path.toLowerCase() && s.agentId === a.id)?.sessionId
              if (sessionId) records ??= await window.combwork.invoke('session:list', h.path).catch(() => [])
              const transcript = (sessionId && records?.find((r) => r.id === sessionId)?.transcriptPath) || null
              found.push([key, `${await window.combwork.invoke('pty:buffer', key).catch(() => '')}\n${a.live?.statusMessage ?? ''}`, transcript])
            }
          }
          return found
        })
        .catch(() => [])
      for (const [key, text, transcript] of texts) out.set(key, [...environmentProblems(text), ...storePwshRefusals(transcriptText(transcript))])
    }
  return out
}

/**
 * Whether a failed CLI step (cliStep) failed because of the environment, decided only from what is known for sure:
 * { skip: why } or { note: why } (a new environment failure, but the failure can't be put down to it) or null. Only a
 * failed check in the step counts, the waits the suite marked as the CLI's: an exception (a bug, a rejected IPC call, a
 * file error) is never the environment's, so a step that threw is a note at most and the exception stays a failure.
 * The suite's checks must report to lib (checked), none may have failed before the step, and a new environment failure
 * must have appeared during the step in its own session (session: its pty key; else any): more of them at the end
 * than at the start, so one the CLI recovered from earlier doesn't count.
 */
function stepVerdict({ name, session = null, before, after, stepFailed, error, failedBefore, wired }) {
  if (!stepFailed && !error) return null
  let fresh = null
  for (const [key, problems] of after) {
    if (session && key !== session.toLowerCase()) continue
    const had = before.get(key)?.length ?? 0
    if (problems.length > had) fresh = { key, why: problems[had].why }
  }
  if (!fresh) return null
  const where = `in "${name}", ${fresh.key}`
  const why = error ? `the step threw (${error?.name ?? 'Error'}: ${error?.message ?? error})` : !wired ? "the suite's checks don't report to lib.checked" : failedBefore ? `${failedBefore} check(s) failed before it` : null
  if (why) return { note: `${fresh.why} (${where}; not a skip: ${why})` }
  return { skip: `environment: ${fresh.why} (${where})` }
}

/** The suite's checks, as far as they report them (checked): failures outside a CLI step, and the step running. */
const checks = { wired: false, failed: 0, step: null }

/** A suite's check reports its result here, so a CLI step knows whether it failed and whether anything failed before. */
function checked(ok) {
  checks.wired = true
  if (ok) return
  if (checks.step) checks.step.failed++
  else checks.failed++
}

/** The longest a skipped step waits for its test copies to close before the suite exits: a bound for a hung close. */
const CLOSE_MS = 10000

/**
 * Runs a step that depends on the real CLI answering (a turn, a start), in a real-CLI suite. If a check in it failed
 * (it didn't throw) and a new environment failure appeared in its session meanwhile (stepVerdict), the suite stops
 * there as skipped: `SKIPPED environment: <why>` and the number of its failed checks (`SKIPPED-FAILS n`), which the
 * runner (suiteOutcome) accepts only if no other FAIL line was printed. Anything else carries on as usual: an
 * exception is thrown on, and a failure before the step, or with no new environment failure in its session, stays a
 * FAIL. So waits on the CLI in a step end in a check, not a throw. opts.session: the step's pty key.
 */
async function cliStep(name, opts, fn) {
  if (typeof opts === 'function') [fn, opts] = [opts, {}]
  const before = await sessionProblems()
  const step = { failed: 0 }
  checks.step = step
  let error = null
  let value
  try {
    value = await fn()
  } catch (e) {
    error = e
  }
  checks.step = null
  if (step.failed || error) {
    const v = stepVerdict({ name, session: opts.session, before, after: await sessionProblems(), stepFailed: step.failed, error, failedBefore: checks.failed, wired: checks.wired })
    if (v?.skip) {
      console.log(`SKIPPED ${v.skip}`)
      console.log(`SKIPPED-FAILS ${step.failed}`)
      // Its test copies close first, so nothing it started is left running.
      await Promise.race([Promise.all([...apps].map((a) => a.close().catch(() => undefined))), sleep(CLOSE_MS)])
      process.exit(0)
    }
    if (v?.note) console.log(`ENVIRONMENT ${v.note}`)
  }
  checks.failed += step.failed
  if (error) throw error
  return value
}

/** Whether a terminal's output (pty:buffer) last turned bracketed paste on rather than off. */
const pasteOn = (raw) => raw.lastIndexOf('\x1b[?2004h') > raw.lastIndexOf('\x1b[?2004l')

/**
 * Types a prompt into a CLI's terminal (pty key) and presses Enter until it is submitted: submitted() turns true (the
 * session working, say) within waitMs. Each attempt types as Combwork does (sessions.sendPrompt): Ctrl+U as a write of its
 * own to clear the input (in a write with the text it can become part of it, doubling a retried prompt: #1168, #1547),
 * then the prompt, then Enter. submitted() is checked before each retry, so a prompt taken late isn't sent twice.
 * - Pasted (a CLI with bracketed paste on, the prompt not a slash command): an attempt not taken is pasted again whole.
 *   The paste's end mark keeps its Enter an Enter, so what is left in the input is never the prompt plus a new line,
 *   and a CLI that emptied its input as a notice came (Claude Code's "You've used N% of your weekly limit" just after
 *   start, #1148, #1556) gets the prompt again rather than an Enter on nothing.
 * - Typed: a CLI can take typing read in one go as a paste, and the Enter right after it as a new line in it (#190):
 *   when this attempt's text was drawn, the next attempt is Enter alone (typed again, the prompt would follow that new
 *   line); when it wasn't (dropped while the CLI drew), or on the last attempt, it is typed again.
 * ready(), if given, is waited for (within waitMs) before the first attempt: the CLI able to take a prompt
 * (hiveToolsConnected); not ready by then, it is typed anyway and said. Up to `tries` times; returns the attempt that
 * worked (1 = the first), or 0.
 */
async function sendPrompt(inv, key, text, { submitted, ready = null, tries = 3, waitMs = 20000 } = {}) {
  const raw = async () => (await inv('pty:buffer', key).catch(() => '')) ?? ''
  if (ready && !(await until(ready, waitMs, 250))) console.log(`INFO sendPrompt: not ready within ${waitMs / 1000} s, typed anyway`)
  let echoed = false
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1 && (await submitted())) return attempt - 1
    // A slash command is typed (pasted, it would be sent as a message), as is any prompt to a CLI without it on.
    const paste = pasteOn(await raw()) && !text.startsWith('/')
    const enterOnly = !paste && echoed && attempt < tries
    const mark = (await raw()).length
    if (!enterOnly) {
      await inv('pty:write', key, '\x15')
      await sleep(150)
      await inv('pty:write', key, paste ? `\x1b[200~${text}\x1b[201~` : text)
    }
    // Deliberate pause, not a wait for a state: a CLI takes an Enter that comes within its paste window as part of the
    // text (a new line, not a submit), and nothing on screen says when that window ends: Copilot shows the line at once
    // and still takes an Enter right after it as part of the paste (tried in #527). submitted() is the check.
    await sleep(400)
    // Whether the CLI drew the text after this attempt's write (#981's evidence; for a typed prompt, what the next
    // attempt does), and whether it is on the screen's last input line ("> …") now: read from the output as drawn, so a
    // guess at the screen, said for an attempt not taken.
    echoed = !enterOnly && plainText((await raw()).slice(mark)).includes(text.slice(0, 30))
    await inv('pty:write', key, '\r')
    if (await until(submitted, waitMs, 500)) return attempt
    const screen = plainText(await raw())
    const input = screen.slice(screen.lastIndexOf('> ') + 2)
    console.log(`INFO sendPrompt attempt ${attempt} not taken: ${enterOnly ? 'Enter only (typed, its text drawn before)' : `${paste ? 'pasted' : 'typed'}, echoed ${echoed ? 'yes' : 'no'}`}, ${input.includes(text.slice(0, 30)) ? 'its text on the last input line' : 'its text not on the last input line'}; screen ends: ${JSON.stringify(screen.slice(-300))}`)
  }
  return 0
}

/**
 * Whether Combwork's log in a test profile (HIVE_USER_DATA) says an agent's Combwork tools connected (#865), at or after
 * `since` (a line count from hiveLogLines, so a relaunch's own connect is waited for): a ready() for sendPrompt into a
 * just-started Claude Code, as Combwork itself types nothing before it (sessions.hiveToolsSettled). A build from before
 * HI-2584 (a packaged suite's older build) logged it as "hive tools": both are read.
 */
const hiveLogLines = (userData) => {
  try {
    return fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8').split('\n')
  } catch {
    return []
  }
}
const hiveToolsConnected = (userData, agentId, since = 0) => hiveLogLines(userData).slice(since).some((l) => l.includes(`⁨${agentId}⁩'s Combwork tools connected`) || l.includes(`⁨${agentId}⁩'s hive tools connected`))

/**
 * The longest a fake Claude Code's prompt waits to be taken, or its turn to end: a bound for a hung run, never how long
 * it should take (#570). Under load the fake took a prompt 10 s after it was typed (#672).
 */
const TURN_HUNG_MS = 60000

/** Whether a fake Claude Code takes a prompt now, by its session:live entry: idle, its turn not running. */
const FAKE_IDLE = (s) => ['ready', 'finished', 'watching', 'background'].includes(s?.status) && s?.turn?.state !== 'running'

/**
 * Turns on the fake Claude Code's input log in its home (CLAUDE_CONFIG_DIR): each read of its input goes into
 * fake-input.jsonl there (#1286), which typeLine() reads. Before the fake starts: it looks for the switch only then.
 */
function logFakeInput(home) {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'fake-log-input.txt'), '')
}

/**
 * Types a line into a fake Claude Code (pty `key`, its home `home`, the agent's name `agent`, or null for live()'s
 * agentName: its CW_AGENT, which the fake's records carry) that Combwork may type a wake
 * into at the same moment (#1553, #1560): the wake's Ctrl+U clears the line, or the two lines mix, or the line lands
 * while the agent is busy with the wake and is dropped (fake-dropped.jsonl). So its Enter goes only once the CLI has
 * read the line whole (fake-input.jsonl: logFakeInput() before the fake starts), the line counts only when nothing
 * else was on it (since the last Enter or Ctrl+U) or between it and its Enter, and it is typed again when it was
 * disturbed, dropped, or not taken within `hungMs`.
 * - live(): the agent's session:live entry. The line is taken once its turn is another than just before it was typed
 *   (each attempt's own, so a wake's turn before it doesn't count): a turn's start, not its end, so a line whose
 *   command runs long isn't typed again.
 * - taken(): true once the line was taken, instead (a run it starts showing in Progress, the agent working on a
 *   held turn): something seen as the line starts, never as its work ends. One of live and taken is required.
 * - ready(): waited for before each attempt; with live and no ready, until the fake takes prompts (idle, its turn not
 *   running, as fakePrompts has it). Not ready within `hungMs`, the line is typed anyway (and said why); with `strict`
 *   (HI-1918), never: that attempt is lost unready, nothing typed, and the next one waits again.
 * - A slash command (/rename, /compact) starts no turn: taken once it was read intact and not dropped.
 * - disturb: for the suite that shows the helper types again (progressreport), the first attempt disturbed as a wake
 *   would: 'enter', a Ctrl+U between the line and its Enter; 'before', a wake's text on the line (read) before it.
 * Returns { attempt, lost }: the attempt taken (1 = the first; 0 if none of `tries` was), and why each before it wasn't.
 */
/**
 * Whether Combwork has nothing waiting to type into an agent (HI-1918): none of its deliveries waiting to be offered (queued,
 * or uncertain: to be offered again), as GET …/deliveries reads them with a token of its project (its own). One offered
 * is typed already (a doorbell, or a launch's first prompt, which stays offered until the agent reads its inbox: never
 * waited for). With the agent idle and its composer free (Combwork not typing a line into it now, `agentQuiet`), for
 * typeLine's ready with `strict`.
 */
async function inboxQuiet(apiPort, project, agent, token) {
  const rows = await inboxPending(apiPort, project, agent, token)
  return !!rows && rows.every((d) => d.state === 'offered')
}

/**
 * Whether Combwork will type nothing into an agent now or next (HI-1918): idle (ready or finished), its composer free (no
 * line of Combwork's being typed, just typed or confirmed: RuntimeFacts.composer), and nothing waiting to be offered
 * (inboxQuiet). `state` is its session:live entry.
 */
async function agentQuiet(apiPort, project, state, token) {
  if (!state || !['ready', 'finished'].includes(state.status) || state.runtime?.composer !== 'free') return false
  return inboxQuiet(apiPort, project, state.agentName, token)
}

/**
 * Whether an agent a lane gave a new conversation (HI-2232: an idle builder outside slots, whose first turn is the lane's
 * brief) is done with that brief, so a line typed into it now is taken: a new conversation (its sessionId isn't
 * `before`), its turn over, and quiet (agentQuiet). Quiet alone isn't the brief done (HI-2350, HI-2357): Combwork answers a
 * hook before it handles it, so under load the brief's UserPromptSubmit can reach its status after the CLI has read its
 * inbox, and the conversation looks ready, its composer free and nothing waiting, while the brief runs; a line typed
 * then is dropped (fake-dropped.jsonl). `state` is its session:live entry.
 */
async function laneBriefDone(apiPort, project, state, before, token) {
  return !!state && state.sessionId !== before && state.turn?.state === 'over' && agentQuiet(apiPort, project, state, token)
}

/** An agent's unread deliveries (id, kind, state, offered), or null when they can't be read. */
async function inboxPending(apiPort, project, agent, token) {
  const res = await fetch(`http://127.0.0.1:${apiPort}/v1/projects/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}/deliveries?limit=200`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
  if (!res?.ok) return null
  const v = await res.json().catch(() => null)
  return v ? (v.deliveries ?? []).filter((d) => d.state === 'queued' || d.state === 'offered' || d.state === 'uncertain').map((d) => ({ id: d.id, kind: d.kind, state: d.state, offered: d.offered ?? null, text: d.text })) : null
}

/**
 * What is left on a fake CLI's input line after it read `s` (HI-2385): an Enter or a Ctrl+U clears it, a DEL or a
 * Backspace erases its last character (as fake-claude does; Combwork withdraws a doorbell it typed with DELs), the rest is
 * typed onto it.
 */
function lineLeft(s) {
  let line = []
  for (const ch of s) {
    if (ch === '\r' || ch === '\x15') line = []
    else if (ch === '\x7f' || ch === '\b') line.pop()
    else line.push(ch)
  }
  return line.join('')
}

async function typeLine(inv, key, home, agent, text, { live = null, taken = null, ready = null, strict = false, tries = 3, hungMs = TURN_HUNG_MS, disturb = null } = {}) {
  if (!live && !taken) throw new Error('typeLine: give it live or taken')
  if (!fs.existsSync(path.join(home, 'fake-log-input.txt'))) throw new Error(`typeLine: the fake's input log is off in ${home} (lib.logFakeInput before it starts)`)
  const name = agent ?? (live ? (await live())?.agentName : null)
  if (!name) throw new Error(`typeLine: no agent name for ${key} (its session isn't live)`)
  if (live && !ready) ready = async () => FAKE_IDLE((await live()) ?? null)
  const jsonl = (f) => (fs.existsSync(path.join(home, f)) ? fs.readFileSync(path.join(home, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((r) => r.agent === name)
  // All the agent's CLI has read, its key sequences (a bracketed paste's marks) left out: what is on its line as the
  // suite types can have come before (a wake's Ctrl+U and text, read just before the suite's line, #1560).
  const readAll = () => jsonl('fake-input.jsonl').map((r) => r.data).join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  const lost = []
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (ready && !(await until(ready, hungMs, 250))) {
      // Strict: a line typed while it isn't ready is the race it waits out, so none is (HI-1918).
      if (strict) {
        lost.push(`not ready within ${hungMs / 1000} s, not typed`)
        continue
      }
      lost.push(`not ready within ${hungMs / 1000} s, typed anyway`)
    }
    const turn = async () => (await live())?.turn?.id ?? null
    const turnBefore = live && !taken ? await turn() : null
    const took = async () => (taken ? await taken() : text.startsWith('/') || (await turn()) !== turnBefore)
    const from = readAll().length
    const readSince = () => readAll().slice(from)
    const dropped = jsonl('fake-dropped.jsonl').length
    // Its line empty first: a wake Combwork is typing (its Ctrl+U and text read, its Enter not yet) is let finish. Bounded:
    // what never clears is typed over, and seen as disturbed below.
    await until(() => lineLeft(readAll()) === '', hungMs)
    if (disturb === 'before' && attempt === 1) {
      const wake = '[CW] A wake typed as the suite types.'
      await inv('pty:write', key, wake)
      await until(() => readSince().includes(wake), hungMs)
    }
    await inv('pty:write', key, text)
    // Read whole before its Enter (the fake reads a line, as a CLI does).
    if (!(await until(() => readSince().includes(text), hungMs))) {
      lost.push('never read')
      continue
    }
    if (disturb === 'enter' && attempt === 1) {
      await inv('pty:write', key, '\x15')
      await until(() => readSince().includes(`${text}\x15`), hungMs)
    }
    await inv('pty:write', key, '\r')
    const read = await until(() => {
      const s = readAll()
      const i = s.indexOf(text, from)
      return i >= 0 && s.indexOf('\r', i) >= 0 ? s : null
    }, hungMs)
    // Intact: nothing on the line before it (since the last Enter or Ctrl+U, however long before it was read, and
    // what a DEL erased gone, lineLeft), and nothing between it and its Enter.
    const at = read ? read.indexOf(text, from) : -1
    const intact = !!read && lineLeft(read.slice(0, at)) === '' && read.slice(at + text.length, read.indexOf('\r', at)) === ''
    if (!intact) {
      lost.push(`disturbed: ${JSON.stringify((read ?? readAll()).slice(Math.max(0, from - 200)))}`)
      continue
    }
    const droppedNow = () => jsonl('fake-dropped.jsonl').slice(dropped).some((r) => text.includes(r.text.slice(0, 50)))
    await until(async () => droppedNow() || (await took()), hungMs, 250)
    // Dropped first: a wake's turn can pass for the line's (the agent working).
    if (droppedNow()) {
      lost.push('dropped while busy')
      continue
    }
    if (await took()) {
      if (lost.length) console.log(`(${name}'s line typed again: ${lost.join('; ')})`)
      return { attempt, lost }
    }
    lost.push(`not taken within ${hungMs / 1000} s`)
  }
  console.log(`(${name}'s line not taken: ${lost.join('; ')})`)
  return { attempt: 0, lost }
}

/**
 * Prompts typed into the fake Claude Code (fake-claude/) in a session (pty `key`; `live()` gives its session:live entry),
 * each waited for by its own turn (#672, #684). Two gaps open under load when a suite types a prompt and then waits for
 * the status: the status is still the last turn's "finished" until the fake takes the new prompt, so the wait returns
 * at once; and Combwork has a turn finished at the fake's Stop hook, but the fake ends it on its side (drawing "✻ Worked
 * for" and its input line) only after the hook's reply, and drops an Enter typed in between.
 * A third: a line Combwork types into the session itself (a mode message, a wake) can be taken late, and a prompt typed
 * meanwhile is dropped while the turn that ends is Combwork's. So a prompt counts as taken only once its conversation has it,
 * and as answered once a reply follows it there and Combwork's turn ledger has the turn over.
 * - type(text): types `text` and Enter once the fake takes prompts: the session idle and its screen showing its last turn
 *   over (no spinner drawn since the last "✻ Worked for"). Throws, with what it showed, without typing if it never does.
 *   Returns what over() needs.
 * - over(typed): waits for the typed prompt in the conversation, then for its reply and the turn over (Combwork's turn
 *   ledger, a turn after the one before it); the turn's id, or null with the session, its conversation, its screen and
 *   the hooks that didn't reach Combwork (fake-hook-errors.jsonl in `opts.home`, its CLAUDE_CONFIG_DIR) logged, and
 *   `opts.why(text)` called for more evidence.
 * - say(text): both.
 * For the fake's prompts that end with a reply (not /compact, /rename or a refused sign-in: type() alone for those).
 * Each wait is bounded by `opts.hungMs` (TURN_HUNG_MS) and logs how long one not done at the first look took.
 */
function fakePrompts(inv, key, live, { hungMs = TURN_HUNG_MS, home = null, why = null } = {}) {
  const screen = async () => (await inv('pty:buffer', key).catch(() => '')) ?? ''
  const takesPrompts = async () => {
    const b = await screen()
    return FAKE_IDLE(await live()) && b.lastIndexOf('✻ Worked for') >= b.lastIndexOf('(esc to interrupt)')
  }
  /** Its conversation from item `from` on (all of it by default), as the Sessions tab reads it. */
  const conversation = async (from) => {
    const s = await live()
    const t = s?.sessionId ? await inv('transcript:read', s.projectPath, s.sessionId, from === undefined ? undefined : { from }).catch(() => null) : null
    return t ?? { total: 0, from: 0, items: [] }
  }
  const short = (text) => JSON.stringify(text.slice(0, 50))
  const type = async (text) => {
    const t = Date.now()
    let looks = 0
    if (!(await until(async () => (looks++, await takesPrompts()), hungMs))) throw new Error(`${short(text)} not typed: the fake didn't take prompts within ${hungMs / 1000} s; the session ${JSON.stringify((await live())?.status)}, its turn ${JSON.stringify((await live())?.turn ?? null)}, its screen ends ${JSON.stringify((await screen()).slice(-300))}`)
    if (looks > 1) console.log(`  (it took prompts again ${Date.now() - t} ms after ${short(text)} was due)`)
    const before = (await live())?.turn?.id ?? null
    const items = (await conversation()).total
    // With the fake's input log on (lib.fakeClaude turns it on), typed as typeLine types (a wake of Combwork's may disturb
    // it, #1560); without, a pause before its Enter, on purpose: the fake reads a typed line before its Enter, as a CLI does.
    if (home && fs.existsSync(path.join(home, 'fake-log-input.txt'))) await typeLine(inv, key, home, null, text, { live, ready: takesPrompts, hungMs })
    else {
      await inv('pty:write', key, text)
      await sleep(300)
      await inv('pty:write', key, '\r')
    }
    return { text, before, items }
  }
  const over = async ({ text, before, items }) => {
    const t = Date.now()
    // Where the prompt is in its conversation (an item's id is its index), and whether a reply follows it.
    const asked = async () => {
      const c = await conversation(items)
      const at = c.items.findIndex((x) => x.kind === 'user' && x.text.trim() === text.trim())
      return at < 0 ? null : { replied: c.items.slice(at + 1).some((x) => x.kind === 'assistant') }
    }
    const taken = await until(asked, hungMs, 250)
    if (Date.now() - t > 2000) console.log(`  (the prompt ${short(text)} ${taken ? 'was taken' : 'was not taken'} after ${Date.now() - t} ms)`)
    const ended = !!taken && (await until(async () => {
      const s = await live()
      return s?.turn?.id && s.turn.id !== before && s.turn.state === 'over' && s.status !== 'working' && (await asked())?.replied ? s.turn.id : null
    }, hungMs, 250))
    if (ended) return ended
    console.log(`DIAGNOSTIC the prompt ${short(text)} ${taken ? "wasn't answered" : "wasn't taken (not in its conversation)"}; the session: ${JSON.stringify((await live()) ?? null)}`)
    console.log(`DIAGNOSTIC its conversation since: ${JSON.stringify((await conversation(items)).items.map((x) => `${x.kind}: ${String(x.text ?? '').slice(0, 80)}`))}`)
    console.log(`DIAGNOSTIC its screen ends ${JSON.stringify((await screen()).slice(-400))}`)
    const failed = home && fs.existsSync(path.join(home, 'fake-hook-errors.jsonl')) ? fs.readFileSync(path.join(home, 'fake-hook-errors.jsonl'), 'utf8').trim().split(/\r?\n/) : []
    console.log(`DIAGNOSTIC hooks that didn't reach Combwork: ${home ? (failed.length ? failed.join(' | ') : 'none') : '(its home not given)'}`)
    // Prompts the fake dropped because it was busy (#725: one typed as a compaction ended).
    const dropped = home && fs.existsSync(path.join(home, 'fake-dropped.jsonl')) ? fs.readFileSync(path.join(home, 'fake-dropped.jsonl'), 'utf8').trim().split(/\r?\n/) : []
    console.log(`DIAGNOSTIC prompts the fake dropped while busy: ${home ? (dropped.length ? dropped.join(' | ') : 'none') : '(its home not given)'}`)
    if (why) await why(text)
    return null
  }
  const say = async (text) => over(await type(text))
  return { screen, takesPrompts, type, over, say }
}

/** Skips the whole suite with a reason (the run record shows it): for a suite that can't run on this machine. */
function skip(reason) {
  console.log(`SKIPPED ${reason}`)
  process.exit(0)
}

/**
 * What git says when another git process holds the repository's lock (index.lock, or a ref's): "File exists", or on
 * a busy Windows "Permission denied" while the holder's lock is still being deleted (a scanner has it open, #298).
 */
const GIT_LOCKED = /Unable to create '[^']+\.lock': (File exists|Permission denied)|Another git process seems to be running/i

/**
 * Runs git in a test repository (cmd: a command line after `git`, or its arguments) and returns its output, waiting out
 * the Combwork under test's own git (#199): Combwork refreshes branch status and the Changes tab with `git status`, which holds
 * the repository's index.lock for a moment, so a suite's git command that writes at that moment fails with "Unable to
 * create '…/index.lock': File exists" (or "Permission denied" while that lock is still being deleted on a busy
 * machine, #298). That alone is tried again every 100 ms for up to timeoutMs; any other failure throws at once.
 * opts: execSync's (input, env…).
 */
function git(cwd, cmd, { timeoutMs = 15_000, ...opts } = {}) {
  const start = Date.now()
  let tries = 0
  for (;;) {
    try {
      const o = { cwd, encoding: 'utf8', stdio: 'pipe', ...opts }
      const out = Array.isArray(cmd) ? execFileSync('git', cmd, { env: gitEnv(), ...o }) : execSync(`git ${cmd}`, { env: gitEnv(), ...o })
      // Said in the suite's log, so a run shows how often the race happens.
      if (tries) console.log(`(git ${Array.isArray(cmd) ? cmd.join(' ') : cmd}: waited ${Date.now() - start} ms for another git's lock)`)
      return out
    } catch (e) {
      if (!GIT_LOCKED.test(`${e.stderr ?? ''}\n${e.message ?? ''}`) || Date.now() - start > timeoutMs) throw e
      tries++
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

/** A suite's git on its fixtures: its test Combwork's config (runContext.gitEnv, #1466), written first, as a suite's git may run before any Combwork starts. */
function gitEnv(vars = {}) {
  writeGitConfig(gitConfig())
  return contextGitEnv(vars)
}

/** A git repository with one commit. */
/**
 * A project's config as Combwork reads it (HI-1749): its project.json with this user's view of it over it (Panes or Tiles, the
 * layout and pane placement), which the test profile's ui-state.json keeps by the project's id (else its folder), not
 * project.json. A view saved shows here a moment after Combwork has it (ui-state.json is written about 300 ms later).
 */
function projectConfig(userData, projectPath) {
  const cfg = JSON.parse(fs.readFileSync(path.join(projectPath, '.combwork', 'project.json'), 'utf8'))
  let views = {}
  try {
    views = JSON.parse(fs.readFileSync(path.join(userData, 'ui-state.json'), 'utf8')).projectViews ?? {}
  } catch {
    // None saved yet.
  }
  return { ...cfg, ...(views[`id:${cfg.id}`] ?? views[`path:${path.resolve(projectPath).toLowerCase()}`]) }
}

function gitProject(dir, files = { 'a.ts': 'export const a = 1\n' }) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  const run = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: gitEnv() })
  run('init', '-q')
  run('add', '.')
  run('commit', '-qm', 'init')
}

/**
 * The token in a launch's hook auth file, named in its hook commands (`-H "@<file>"`, in Combwork's user data: no generated
 * file or argument holds the token itself, #345). Null when the text names none or it is gone (the launch ended).
 */
function hookAuthToken(text) {
  const file = /@([A-Za-z]:\/[^"\\]+?\.txt)/.exec(text)?.[1]
  if (!file) return null
  try {
    return /Bearer ([0-9a-f]{16,})/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

/** A running launch's private folder in the test Combwork's user data (its settings, MCP config and hook auth file, #345). */
const launchDir = (userData, runId) => path.join(userData, 'launches', runId)

/**
 * A running Claude Code launch's hook URL (with its run id) and token, from its launch settings (in its private
 * folder): for tests that call the hook server as that launch's hooks do. Each launch has its own token.
 */
function launchHook(userData, runId) {
  const text = fs.readFileSync(path.join(launchDir(userData, runId), 'settings.json'), 'utf8')
  const url = /"(http:\/\/127\.0\.0\.1:\d+\/hook\?run=[0-9a-f]+)"/.exec(text)?.[1]
  const token = hookAuthToken(text)
  return url && token ? { url, token } : null
}

/**
 * The hook URL and token of a running Codex launch, from its command line (the token from the auth file it names).
 * For tests that call the hook server the way Codex does.
 */
function codexHook(runId) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', env: baseEnv() })
  const line = out.split(/\r?\n/).find((l) => l.includes(`run=${runId}`))
  if (!line) return null
  const token = hookAuthToken(line)
  const url = /(http:\/\/127\.0\.0\.1:\d+\/hook)/.exec(line)?.[1]
  return token && url ? { token, url } : null
}

// What still runs from a test's own folder after its Combwork closed (#542): folderProcesses.cjs.
// A process by its identity (pid and start time), never by a remembered pid alone (#603).
const { processTree, stopProcessesIn, identify, stillSame, endExactly, endTreeExactly, endChildTree, recordMainProcess } = require('./folderProcesses.cjs')

/**
 * Whether process `pid` still runs: false only when Windows says there is no such process (ESRCH). Any other error
 * (EPERM…) leaves its state unknown, so it is thrown rather than read as "it exited" (#339).
 */
function processRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    if (e?.code === 'ESRCH') return false
    throw new Error(`Can't tell whether process ${pid} runs: ${e?.code ?? e?.message ?? e}`, { cause: e })
  }
}

const codexSignedIn = () => fs.existsSync(path.join(CODEX_HOME, 'auth.json'))

/**
 * The run context's PATH without the Microsoft Store's app aliases (%LOCALAPPDATA%\Microsoft\WindowsApps), for a test
 * Combwork whose agents run the real Codex (#584): give it as PATH in hiveEnv. Codex runs its commands in PowerShell 7 where
 * it finds one, and its sandbox can't start the Store's while any other process of that package runs on the machine
 * (#499: a test Combwork's terminal, an agent's command), while Windows PowerShell is never refused. leftovers-codex keeps
 * the Store's on purpose, and codex-storepwsh checks the refusal itself.
 */
function pathWithoutStoreAliases(parent = process.env) {
  const key = Object.keys(parent).find((k) => k.toUpperCase() === 'PATH')
  return String((key && parent[key]) || '')
    .split(';')
    .filter((d) => d && !/[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i.test(d.trim().replace(/^"|"$/g, '')))
    .join(';')
}

/** A real PNG (a w×h gradient) for image previews, pastes and drops. */
/**
 * Text agents read with its cards named by number, as before keys (#1219): "AL-1" becomes "#1", so a suite's checks of
 * card numbers stay as they were; each suite checks the keyed form itself (KEYED). Only for a suite whose cards are all
 * one project's, made in order, so a key's digits are its card's number (HI-1661: texts name cards by key alone); a
 * suite where they differ fails its checks, never passes them wrongly. A branch's key (hive/AL/AL-1-…) stays as it is.
 */
const unkey = (text) => (typeof text === 'string' ? text.replace(/(?<![\w/-])[A-Z]{2,4}-(\d+)\b(?!-)/g, '#$1') : text)
/** A card as the window names it (#1221): its key, else #n (a workspace card, or one the board doesn't have). */
async function cardLabel(inv, n) {
  const c = (await inv('tasks:list')).find((x) => x.number === n)
  return c?.key || `#${n}`
}
/**
 * The card dialog of the card named `label` (its key, else #n: cardLabel), its title naming it alone (HI-1661). Its
 * text runs on from the title ("AL-1Login form"), so only another digit after it, or a key's letter or digit before
 * it, makes another card's name.
 */
const cardDialog = (page, label) => page.locator('.dialog', { hasText: new RegExp(`(?<![A-Z0-9#-])${label.replace(/[#-]/g, '\\$&')}(?!\\d)`) })
/** A card named by its key alone in agents' text (HI-1661): "AL-1", never "AL-1 (#1)". */
const KEYED = /\b[A-Z]{2,4}-\d+\b(?! \(#\d)/

function samplePng(w = 64, h = 40) {
  const zlib = require('zlib')
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = 245
      raw[o + 1] = Math.round((x / w) * 158)
      raw[o + 2] = Math.round((y / h) * 255)
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * Whether a progress run was given an estimate. Not whether time is left: Combwork counts the estimate down as the run goes
 * (timeLeft), so a run that outlasts it ends with 0, while one never given an estimate keeps null.
 */
function hadEstimate(run) {
  return typeof run?.estimateMs === 'number'
}

/**
 * Haiku asked for Auto (#129, #234): what the installed Claude Code says about Haiku and Auto (its catalog), the mode
 * it then showed itself (modeObserved: its footer, a hook; never the mode asked for at launch) and the mode Combwork shows.
 * Waits up to timeoutMs for the CLI to show a mode. The caller checks: observed in expected, and shown === observed.
 */
async function haikuAutoMode(inv, host, agentId = 'assistant', timeoutMs = 15000) {
  const info = (await inv('provider:info'))['claude-code']
  const autoOffered = info?.catalog?.models.find((m) => m.value === 'haiku')?.supportsAuto
  const expected = autoOffered === true ? ['auto'] : autoOffered === false ? ['manual'] : ['auto', 'manual']
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === host.toLowerCase() && s.agentId === agentId)
  await until(async () => expected.includes((await live())?.modeObserved), timeoutMs)
  const s = await live()
  return { version: info?.version ?? null, autoOffered, expected, observed: s?.modeObserved, shown: s?.permissionMode }
}

/**
 * The connection dialog's warning about Auto with Haiku (#129; HI-2145: model and mode are a connection's since
 * HI-2108): there exactly when the CLI says Auto isn't offered (saying the session runs in Manual), none when it says
 * it is, the shipped guess ("may not offer") when it doesn't say. Opens Settings → Accounts & Connections (Ctrl+,),
 * Edit… on a Claude Code account's first connection, chooses Haiku and Auto there, waits for the warning to be as it
 * should (the window may still be taking in what the CLI said: the shipped guess first), then cancels, saving
 * nothing. Returns [ok, what it found].
 */
async function haikuAutoCaveat(page, autoOffered, timeoutMs = 10000) {
  // A Combwork account on Claude Code (the view's `connections`: HI-2106 kept the old name); a test copy on its CLI test home
  // has none listed (that home isn't shown in Settings), so one is added for the look, never signed in, and removed after.
  // The warning depends on what the CLI said about its models, not on the account.
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const listed = (await inv('connections:list')).connections.find((a) => a.provider === 'claude-code')
  const account = listed ?? (await inv('connections:add', 'claude-code', 'Auto with Haiku'))
  const form = page.locator('[data-connection-form]')
  try {
    await page.keyboard.press('Control+,')
    const nav = page.locator('.settings-nav .row[data-section="accounts"]')
    await nav.waitFor({ timeout: timeoutMs })
    await nav.click()
    const row = page.locator(`[data-connections-of="${account.id}"] [data-connection]`).first()
    await row.locator('[data-action="connection-menu"]').click({ timeout: timeoutMs })
    await page.locator('.menu .menu-item', { hasText: 'Edit…' }).first().click({ timeout: timeoutMs })
    await form.waitFor({ timeout: timeoutMs })
    await form.locator('select').first().selectOption('haiku', { timeout: timeoutMs })
    await form.locator('select[data-mode]').selectOption('auto', { timeout: timeoutMs })
    const caveat = () => form.locator('.mode-caveat', { hasText: 'Auto with Haiku' }).allInnerTexts()
    const right = (c) => (autoOffered === true ? !c.length : autoOffered === false ? c.length === 1 && /doesn't offer Auto with Haiku.*runs in Manual/.test(c[0]) : c.length === 1 && /may not offer Auto with Haiku/.test(c[0]))
    const ok = !!(await until(async () => right(await caveat()), timeoutMs))
    return [ok, JSON.stringify(await caveat())]
  } finally {
    if (await form.count()) {
      await page.locator('.dialog').last().getByRole('button', { name: 'Cancel' }).click({ timeout: timeoutMs }).catch(() => undefined)
      await form.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => undefined)
    }
    if (!listed) await inv('connections:remove', account.id)
  }
}

/**
 * The project header's Agents ▾ menu (#974: Start New, Archive and Start New, Remove All): opens it and returns its
 * entries' labels (the menu stays open), or [] when the header has no Agents ▾ (no agents, or cramped into ⋯).
 */
async function agentsMenu(page, ms = 10000) {
  const button = page.locator('.project-header .agents-menu')
  if (!(await button.count())) return []
  await button.click()
  await until(async () => (await page.locator('.menu .menu-item').count()) > 0, ms)
  return (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
}

/** Runs the Agents ▾ entry with this label ("Start New (3)", "Remove All (4)…"); throws if it isn't there. */
async function agentsMenuRun(page, label, ms = 10000) {
  const items = await agentsMenu(page, ms)
  if (!items.includes(label)) throw new Error(`Agents ▾ has no "${label}": ${JSON.stringify(items)}`)
  await page.locator('.menu .menu-item').filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first().click()
}

/**
 * Sets some of a project's own workflow options as the form's Save does, its other own options and preset kept (HI-1766:
 * card loops and file locks are options): `undefined` inherits again.
 */
async function setOwnOptions(inv, projectPath, patch) {
  const form = await inv('workflow:form', projectPath)
  const options = Object.fromEntries(Object.entries({ ...form.own, ...patch }).filter(([, v]) => v !== undefined))
  return inv('workflow:setOptions', projectPath, { preset: form.preset, options, base: { preset: form.preset, options: form.own } }, { applyTo: [] })
}

/**
 * Sets Maximum agents (HI-2001, before Settings → Advanced → Agents per project) at a level, for None and Git, as the
 * Workflow defaults' Save does, the level's other options kept: 'global' (Combwork's), 'workspace' (this one's own), or a
 * project's folder (its own options). `null` inherits again.
 */
async function setMaxAgents(inv, n, level = 'global') {
  if (level !== 'global' && level !== 'workspace') return setOwnOptions(inv, level, { maxAgents: n ?? undefined })
  for (const platform of ['none', 'git']) {
    const form = await inv('workflow:levelForm', level, platform)
    const options = Object.fromEntries(Object.entries({ ...form.own, maxAgents: n ?? undefined }).filter(([, v]) => v !== undefined))
    await inv('workflow:setLevel', level, platform, { preset: form.preset, options, base: { preset: form.preset, options: form.own } })
  }
}

/** Opens the project's settings from the tab strip's More ▾ (HI-2551: no longer in the header's ⋯), and waits for them. */
async function openProjectSettings(page, ms = 10000) {
  await page.locator('.tabs .tab-more').click()
  await menuEntry(page, 'Project Settings…').click()
  if (!(await until(async () => (await page.locator('.tab-body .settings-top').count()) > 0, ms))) throw new Error("Project Settings didn't open")
}

/**
 * Opens one of the project tabs in the strip's More ▾ menu (#1043: Memory, Skills, Templates, MCP) and waits for it:
 * More ▾ then shows its name.
 */
async function openMoreTab(page, label, ms = 10000) {
  await page.locator('.tabs .tab-more').click()
  await menuEntry(page, label).click()
  if (!(await until(async () => (await page.locator('.tabs .tab-more.active .tab-label').innerText().catch(() => '')).trim() === label, ms))) throw new Error(`More ▾ didn't open ${label}`)
}

/** A menu entry by its label exactly (its first line, not its detail). */
const menuEntry = (page, label) =>
  page.locator('.menu .menu-item').filter({ has: page.locator(`.menu-label, :scope > span:not(.menu-key)`, { hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }) }).first()

/**
 * Goes to an agent the way the window offers since the agent strip went (#975): the session toolbar's summary chip lists
 * the project's agents; choosing one focuses it (and shows its page). Waits until its pane is the focused one.
 */
async function showAgent(page, name, ms = 10000) {
  await page.locator('.session-toolbar .summary-chip').click()
  if (!(await until(async () => (await menuEntry(page, name).count()) === 1, ms))) throw new Error(`the summary chip doesn't list ${name}: ${JSON.stringify(await page.locator('.menu .menu-item').allInnerTexts())}`)
  await menuEntry(page, name).click()
  // Its pane shown and focused (a pane alone, as with One at a time, isn't marked focused: it is the only one).
  const focused = async () => (await paneHeader(page, name).count()) === 1 && ((await paneHeader(page, name).evaluate((el) => el.classList.contains('focused')).catch(() => false)) || (await page.locator('.pane-header-bar').count()) === 1)
  if (!(await until(focused, ms))) throw new Error(`${name}'s pane isn't focused`)
}

/** How many agents the session toolbar's summary chip counts (#975): its counts added up ("1 waiting · 2 idle" is 3). */
async function agentCount(page) {
  const text = await page.locator('.session-toolbar .summary-chip-text').innerText().catch(() => '')
  return (text.match(/\d+/g) ?? []).reduce((n, x) => n + Number(x), 0)
}

/** An agent's pane header (its pane must be on screen: showAgent first). */
const paneHeader = (page, name) => page.locator('.pane-header-bar').filter({ has: page.locator('.agent-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first()

/** Opens an agent's menu (right-click on its pane's header, as on its tab before #975), showing it first; returns the entries. */
async function agentMenu(page, name, ms = 10000) {
  await showAgent(page, name, ms)
  await paneHeader(page, name).click({ button: 'right', position: { x: 40, y: 8 } })
  await until(async () => (await page.locator('.menu .menu-item').count()) > 0, ms)
  return (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
}

/** Runs the session toolbar's + Add ▾ entry with this label (#975); `then`: an entry of the menu it opens (Templates ▸ → Save Template…). */
async function addMenuRun(page, label, then, ms = 10000) {
  await page.locator('.session-toolbar .add-menu').click()
  if (!(await until(async () => (await menuEntry(page, label).count()) === 1, ms))) throw new Error(`+ Add ▾ has no "${label}": ${JSON.stringify(await page.locator('.menu .menu-item').allInnerTexts())}`)
  await menuEntry(page, label).click()
  if (!then) return
  if (!(await until(async () => (await menuEntry(page, then).count()) === 1, ms))) throw new Error(`"${label}" has no "${then}": ${JSON.stringify(await page.locator('.menu .menu-item').allInnerTexts())}`)
  await menuEntry(page, then).click()
}

module.exports = { PACKAGED_EXE, projectConfig, tokenFile, commitBursts, commitChains, acceptCommitChain, watchCommitBursts, burstWatcher, unkey, KEYED, cardLabel, cardDialog, readCard, writeCard, addMenuRun, agentCount, agentMenu, agentsMenu, agentsMenuRun, menuEntry, openMoreTab, openProjectSettings, setOwnOptions, setMaxAgents, paneHeader, showAgent, ROOT, ELECTRON, WORK, CODEX_HOME, CLAUDE_TEST_HOME, TRASH, TEST_GIT_IDENTITY, trashed, tidyUp, ownClaudeHome, probeDir, hiveEnv, childEnv, baseEnv, gitEnv, git, GIT_LOCKED, plainText, trustChoice, haikuAutoMode, haikuAutoCaveat, sleep, port, until, hoverTip, quitWatch, appReady, openWorkspace, hadEstimate, fitWindow, enableProviders, fakeClaude, launch, waitForProvider, addAgent, setLaunch, setProjectLaunch, soloAgent, ptyKey, acceptClaudeTrust, acceptRelaunchTrust, withFileLock, trustForCodex, gitProject, codexSignedIn, pathWithoutStoreAliases, launchDir, launchHook, codexHook, processTree, stopProcessesIn, identify, stillSame, endExactly, endTreeExactly, endChildTree, processRunning, testExecutable, keepPackagedQuiet, PACKAGED_ARGS, NO_UPDATE_CHECK, noUpdateChecks, updateChecksLogged, samplePng, environmentProblem, environmentProblems, storePwshRefusals, stepVerdict, checked, cliStep, sendPrompt, hiveLogLines, hiveToolsConnected, TURN_HUNG_MS, logFakeInput, inboxQuiet, inboxPending, agentQuiet, laneBriefDone, typeLine, fakePrompts, skip }
