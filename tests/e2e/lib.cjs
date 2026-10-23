// Shared helpers for Hive's end-to-end suites (tests/e2e). They drive the real app with Playwright's
// _electron against a dev build (npx electron-vite build), in throwaway profiles and workspaces under
// WORK, and never touch the real Hive profile, ~/.codex or the clipboard.
//
// Needs: the standalone Claude Code CLI (signed in) and, for the Codex suites, Codex signed in to the test
// home CODEX_HOME. The first Claude Code run in a test folder asks whether to trust it; acceptClaudeTrust
// answers that (it is not a sign-in screen). Suites never automate sign-in screens.
const fs = require('fs')
const path = require('path')
const { execFileSync, execSync } = require('child_process')
const { _electron } = require('playwright-core')

// The run context (runContext.cjs): the environments of everything a suite starts, its folders and the CLI test homes.
const { TEST_ROOT, WORK, CODEX_HOME, CLAUDE_TEST_HOME, hiveEnv, childEnv, baseEnv, isHiveEnv, isUserCliHome, trashDir, TEST_GIT_IDENTITY, gitConfig, writeGitConfig, isUserGitConfig } = require('./runContext.cjs')

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
 * cache) at its end, best effort (#324): a file a CLI or a scanner still holds for a moment after the test Hive closed
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
 * What the test copies of Hive this suite started have deleted, oldest first: `{ at, from, to }` each (the original
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
 * A card of a workspace's board as Hive saved it (in .hive\hive.db: its JSON document, from 1.0's tables, #1209), read on a
 * connection of its own (read-only; Hive writing meanwhile is fine). Throws when there is no such card.
 */
function readCard(ws, n) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { readOnly: true, timeout: 5000 })
  try {
    const [row] = readDocs(db, [n])
    if (!row) throw new Error(`no card #${n} in ${ws}`)
    return row.doc
  } finally {
    db.close()
  }
}

/** Saves a card's document as another program would (a running Hive sees it within about a second, #1017). */
function writeCard(ws, n, doc) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { timeout: 5000 })
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
 * Watches a test copy of Hive quit, telling Hive's part from the process's (#424). Start it before the quit.
 * `untilDecided(ms)`: the time Hive called app.quit (or app.exit), recorded in main as it calls it: its own quit work is
 * done (sessions stopped, state saved), or null if it hasn't within ms. `gone(ms)`: the process has ended since. What
 * comes between (Electron closing windows and processes) is the machine's, and a loaded one stretches it to seconds, so
 * a suite times Hive's part and only waits for the rest. `timings()` says both, for the suite's log.
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
      return `Hive's quit work ${d ? `${d - from} ms` : 'not done'}, the process gone ${d && exitedAt ? `${exitedAt - d} ms after` : exitedAt ? 'without it' : 'not yet'}`
    }
  }
}

/** Turns providers on in a test profile's config before Hive starts (fresh profiles start with none). */
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
 * The fake Claude Code (fake-claude/) for a test profile, for a suite about Hive's own behaviour that only needs some
 * session running (#194): turns Claude Code on in userData's config with the fake as its path, makes home a fresh
 * Claude Code config folder in which the fake trusts `trusted` (so it asks nothing), and returns the variables to start
 * Hive with: { CLAUDE_CONFIG_DIR }. A config written before (a 0.1 one, settings of the suite's) is kept.
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
 * Waits until Hive's window has rendered with its settings loaded, and Hive has finished looking for the providers'
 * CLIs (it does that in the background after start; starting an agent before then fails with "… is required").
 * Instead of a fixed wait after launch.
 */
async function appReady(page, ms = 90000) {
  const ready = () =>
    page
      .evaluate(async () => {
        if (!document.querySelector('.app .workbench')) return false
        const info = await window.hive.invoke('provider:info')
        return Object.values(info).every((p) => !p.checking)
      })
      .catch(() => false)
  const ok = await until(ready, ms)
  if (!ok) throw new Error("Hive's window wasn't ready (rendered, providers found) within " + ms / 1000 + ' s')
}

/** Opens a workspace and waits until the window shows it (its name in the title), instead of a fixed wait. */
async function openWorkspace(inv, page, ws, ms = 20000) {
  await inv('workspace:open', ws)
  const name = path.basename(ws)
  const ok = await until(() => page.evaluate((n) => document.title.includes(n), name).catch(() => false), ms)
  if (!ok) throw new Error(`The window didn't show the workspace ${name} within ${ms / 1000} s`)
}

/**
 * Starts the dev build with a test profile, or the packaged Hive.exe HIVE_EXE names (the Sandbox upgrade checks run
 * boardupgrade and upgradelane against an installed build that way, #1227). Returns { app, page, inv } (inv calls an
 * IPC channel). readyMs bounds the wait for its window to be ready; one that isn't is closed and the failure thrown.
 */
async function launch({ userData, env = {}, viewport = { width: 1400, height: 850 }, readyMs = 90000 }) {
  const exe = process.env.HIVE_EXE
  if (exe && !launch.said) console.log(`Hive: ${exe} (HIVE_EXE), not the dev build`)
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
  const inv = (ch, ...a) => page.evaluate(([c, args]) => window.hive.invoke(c, ...args), [ch, a])
  return { app, page, inv }
}

/**
 * Waits until Hive has finished looking for a provider's CLI (it does so in the background after start): starting
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

/** Adds an agent (Claude Code in the project folder unless told otherwise); returns its definition. */
function addAgent(inv, proj, opts = {}) {
  return inv('agents:add', proj, { location: 'project', provider: 'claude-code', ...opts })
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
 * as soon as the session is past it (Claude Code's prompt on screen, or Hive has the session ready: a trusted folder
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
 * Failures that come from the machine, not from Hive: the CLI's usage or rate limit, its sign-in, the network to its
 * API. Matched in the CLI's own output (terminal text, a session's status message), conservatively: anything not
 * clearly one of these stays a FAIL. Hook errors (127.0.0.1) are Hive's, never the environment's.
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

// Every Hive a suite starts, whether through launch() or Playwright's _electron.launch directly (most suites do that):
// require('playwright-core') is one module, so suites get this _electron. cliStep reads their sessions. Each must have
// the run context's environment (hiveEnv): without one, Playwright would pass on the suite's own.
const apps = new Set()
const launchElectron = _electron.launch.bind(_electron)
_electron.launch = async (...args) => {
  const env = args[0]?.env
  if (!isHiveEnv(env)) throw new Error("Start a test Hive with lib.hiveEnv({ HIVE_USER_DATA, … }) as its env (tests/e2e/runContext.cjs), never the suite's own environment")
  // The CLI homes, test folders (#382, #452): Hive looks for the CLIs when it starts, and their sign-in checks read these.
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GH_CONFIG_DIR']) {
    if (!env[k]) throw new Error(`A test Hive needs ${k} (hiveEnv gives an empty one of the suite's; a suite may give a test home, never none): without it the CLI reads the user's own home (#382)`)
    if (isUserCliHome(env[k])) throw new Error(`A test Hive's ${k} is the user's own home (${env[k]}): give it a test home (#382)`)
    // The suite's empty one is made here (Codex refuses a CODEX_HOME that doesn't exist).
    fs.mkdirSync(env[k], { recursive: true })
  }
  // Its git's global config, the suite's (#1466): without one its git reads the user's ~/.gitconfig, and the user's name
  // and email show in its screens. The work folder's is written here, with the test identity.
  if (!env.GIT_CONFIG_GLOBAL) throw new Error("A test Hive needs GIT_CONFIG_GLOBAL (hiveEnv gives the suite's, with a test identity): without it its git reads the user's ~/.gitconfig (#1466)")
  if (isUserGitConfig(env.GIT_CONFIG_GLOBAL)) throw new Error(`A test Hive's GIT_CONFIG_GLOBAL is the user's own (${env.GIT_CONFIG_GLOBAL}): give it the suite's (#1466)`)
  if (env.GIT_CONFIG_GLOBAL === gitConfig()) writeGitConfig(env.GIT_CONFIG_GLOBAL)
  const packaged = testExecutable(args[0].executablePath ?? ELECTRON) === 'packaged'
  // Its profile on its command line (#614), which Hive ignores: the runner stops what names a suite's folder once the
  // suite ends, and a test Hive's own line names only the checkout, so a suite killed before closing its Hive (HB1's,
  // 10 Oct) left it running for a day. Chromium's own processes already name it (--user-data-dir).
  if (env.HIVE_USER_DATA) args[0] = { ...args[0], args: [...(args[0].args ?? []), `--hive-test-profile=${env.HIVE_USER_DATA}`] }
  if (packaged) {
    args[0] = { ...args[0], args: [...args[0].args, ...PACKAGED_ARGS], env: { ...env, ...NO_UPDATE_CHECK } }
    unmaximized(env.HIVE_USER_DATA)
    noUpdateChecks(env.HIVE_USER_DATA)
    if (env.HIVE_USER_DATA) packagedLaunches.push({ profile: env.HIVE_USER_DATA, since: new Date().toISOString() })
  }
  const app = await launchElectron(...args)
  // An app.evaluate reaches main through Node's inspector, which runs it at once even while main's JS is running: in a
  // V8 interrupt, in the middle of whatever main was doing. A function that calls into Hive (a window event, a setting)
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
  if (packaged) {
    const shown = await app.evaluate(keepPackagedQuiet).catch((e) => ({ error: e.message }))
    if (!Array.isArray(shown) || shown.length) {
      await app.close().catch(() => undefined)
      throw new Error(`A packaged test Hive (${args[0].executablePath}) couldn't be kept off the screen (#1253): ${Array.isArray(shown) ? `its windows were shown before it was reached (${shown.join(', ')})` : shown.error}`)
    }
  }
  return app
}

/** The Hives a suite may never start (#1253): the installed app (the one hosting the agents, with its own profile and app ID). */
const INSTALLED = [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Hive'), path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Hive')]
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
 * Which Hive a suite starts: 'dev' (this checkout's Electron, the dev build) or 'packaged' (a Hive.exe: this checkout's
 * dist\win-unpacked, the main checkout's 0.9 one boardupgrade and upgradelane use, one in the test folders, or what
 * HIVE_E2E_HIVE09 or HIVE_EXE name). Never the installed Hive, nor one from anywhere else (#1253): it would open the user's
 * app on their screen. Throws for those.
 */
function testExecutable(exe) {
  if (comparable(exe) === comparable(ELECTRON)) return 'dev'
  if (INSTALLED.some((d) => d && inside(exe, d))) throw new Error(`A test may never start the installed Hive (${exe}): use this checkout's build, or a 0.9 build's win-unpacked folder (HIVE_E2E_HIVE09) (#1253)`)
  const named = [ROOT, TEST_ROOT, process.env.HIVE_E2E_HIVE09, process.env.HIVE_EXE && path.dirname(process.env.HIVE_EXE)].filter(Boolean)
  if (named.some((d) => inside(exe, d))) return 'packaged'
  // Asked of git only now: in Windows Sandbox the checkout is a mapped copy, not a repository (#1227).
  const main = /^worktree (.+)$/m.exec(git(ROOT, 'worktree list --porcelain'))?.[1]
  if (!main || !inside(exe, path.join(main, 'dist', 'win-unpacked'))) throw new Error(`A test starts Hive from this checkout, its dist, the main checkout's dist\\win-unpacked or the test folders, never ${exe} (#1253)`)
  return 'packaged'
}

/**
 * What a packaged test Hive starts with (#1253): --hidden (Hive makes its windows but never shows them, as when started at
 * sign-in: 0.9 too), so nothing is on screen before keepPackagedQuiet reaches it; and Chromium's occlusion tracking off,
 * so its windows, once shown off screen, still draw (main does that itself for a quiet copy).
 */
const PACKAGED_ARGS = ['--hidden', '--disable-features=CalculateNativeWinOcclusion']

/**
 * A profile saved with its window maximised: Hive would maximise it as it starts, and maximising shows a hidden window.
 * A packaged test Hive's profile is set not to (#1253). Kept files' copies (.bak) are left: config.json is read first.
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
    // Unreadable: Hive starts with its defaults.
  }
}

/**
 * A packaged test Hive never checks GitHub for updates (#1332): each check fetches the release's latest.yml, which
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
    // Unreadable: Hive starts with its defaults, and HIVE_UPDATE_DELAY still puts its check off.
  }
}

/**
 * The guard (#1332): when a suite ends, the log of each packaged Hive it started (hive.log and its older copy) must show
 * no update check since that launch (electron-updater's "Checking for update", in Hive's [updates] scope), or the suite
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
  console.error(`FAILED: a packaged test Hive checked GitHub for updates (#1332):\n${found.join('\n')}`)
  process.exitCode = 1
})

/**
 * Run in a packaged test Hive's main process as soon as Playwright reaches it (#1253), making it quiet from outside, as
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
  // One made later, hidden too (--hidden), is shown once it has drawn, as Hive shows its own.
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
 * The environment failures in each session of the running test Hives: Map<pty key, problems> (its terminal and status,
 * and the launches Codex's sandbox refused as its running session's transcript records them).
 */
async function sessionProblems() {
  const out = new Map()
  for (const app of apps)
    for (const page of app.windows()) {
      const texts = await page
        .evaluate(async () => {
          const ws = await window.hive.invoke('workspace:get')
          const hosts = ws ? [...ws.projects, ...(ws.assistant ? [ws.assistant] : [])] : []
          const live = await window.hive.invoke('session:live').catch(() => [])
          const found = []
          for (const h of hosts) {
            let records = null
            for (const a of h.agents ?? []) {
              const key = `session:${h.path.toLowerCase()}#${a.id}`
              const sessionId = live.find((s) => s.projectPath.toLowerCase() === h.path.toLowerCase() && s.agentId === a.id)?.sessionId
              if (sessionId) records ??= await window.hive.invoke('session:list', h.path).catch(() => [])
              const transcript = (sessionId && records?.find((r) => r.id === sessionId)?.transcriptPath) || null
              found.push([key, `${await window.hive.invoke('pty:buffer', key).catch(() => '')}\n${a.live?.statusMessage ?? ''}`, transcript])
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

/** The longest a skipped step waits for its test Hives to close before the suite exits: a bound for a hung close. */
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
      // Its test Hives close first, so nothing it started is left running.
      await Promise.race([Promise.all([...apps].map((a) => a.close().catch(() => undefined))), sleep(CLOSE_MS)])
      process.exit(0)
    }
    if (v?.note) console.log(`ENVIRONMENT ${v.note}`)
  }
  checks.failed += step.failed
  if (error) throw error
  return value
}

/**
 * Types a prompt into a CLI's terminal (pty key) and presses Enter until it is submitted: submitted() turns true (the
 * session working, say) within waitMs. Under load a CLI can take the prompt, written at once, as a paste and the Enter
 * right after it as a new line in it, or drop what was typed while it was still drawing (#190): if the text is in the
 * terminal, Enter is pressed again; if not, it is typed again over a cleared line (Ctrl+U). Up to `tries` times; returns
 * the attempt that worked (1 = the first), or 0.
 */
async function sendPrompt(inv, key, text, { submitted, tries = 3, waitMs = 20000 } = {}) {
  const raw = async () => (await inv('pty:buffer', key).catch(() => '')) ?? ''
  for (let attempt = 1; attempt <= tries; attempt++) {
    // Text seen on screen is taken to be still in the input (an Enter it didn't take is pressed again). The terminal's
    // output is everything ever drawn, so text a CLI drew and then cleared (redrawing its input as a notice came, #981)
    // counts as seen too: the last attempt types it again whatever was seen, so no run is left pressing Enter on nothing.
    const typed = attempt > 1 && attempt < tries && plainText(await raw()).includes(text.slice(0, 30))
    const mark = (await raw()).length
    if (attempt === 1) await inv('pty:write', key, text)
    else if (!typed) await inv('pty:write', key, `\x15${text}`)
    // Deliberate pause, not a wait for a state: a CLI takes an Enter that comes within its paste window as part of the
    // text (a new line, not a submit), and nothing on screen says when that window ends: Copilot shows the line at once
    // and still takes an Enter right after it as part of the paste (tried in #527). submitted() is the check.
    await sleep(400)
    // Whether the CLI drew the text after this attempt's write: said for an attempt not taken (#981's evidence).
    const echoed = plainText((await raw()).slice(mark)).includes(text.slice(0, 30))
    await inv('pty:write', key, '\r')
    if (await until(submitted, waitMs, 500)) return attempt
    console.log(`INFO sendPrompt attempt ${attempt} not taken: ${attempt === 1 || !typed ? 'typed' : 'Enter only (its text seen before)'}, echoed ${echoed ? 'yes' : 'no'}; screen ends: ${JSON.stringify(plainText(await raw()).slice(-300))}`)
  }
  return 0
}

/**
 * The longest a fake Claude Code's prompt waits to be taken, or its turn to end: a bound for a hung run, never how long
 * it should take (#570). Under load the fake took a prompt 10 s after it was typed (#672).
 */
const TURN_HUNG_MS = 60000

/**
 * Prompts typed into the fake Claude Code (fake-claude/) in a session (pty `key`; `live()` gives its session:live entry),
 * each waited for by its own turn (#672, #684). Two gaps open under load when a suite types a prompt and then waits for
 * the status: the status is still the last turn's "finished" until the fake takes the new prompt, so the wait returns
 * at once; and Hive has a turn finished at the fake's Stop hook, but the fake ends it on its side (drawing "✻ Worked
 * for" and its input line) only after the hook's reply, and drops an Enter typed in between.
 * A third: a line Hive types into the session itself (a mode message, a wake) can be taken late, and a prompt typed
 * meanwhile is dropped while the turn that ends is Hive's. So a prompt counts as taken only once its conversation has it,
 * and as answered once a reply follows it there and Hive's turn ledger has the turn over.
 * - type(text): types `text` and Enter once the fake takes prompts: the session idle and its screen showing its last turn
 *   over (no spinner drawn since the last "✻ Worked for"). Throws, with what it showed, without typing if it never does.
 *   Returns what over() needs.
 * - over(typed): waits for the typed prompt in the conversation, then for its reply and the turn over (Hive's turn
 *   ledger, a turn after the one before it); the turn's id, or null with the session, its conversation, its screen and
 *   the hooks that didn't reach Hive (fake-hook-errors.jsonl in `opts.home`, its CLAUDE_CONFIG_DIR) logged, and
 *   `opts.why(text)` called for more evidence.
 * - say(text): both.
 * For the fake's prompts that end with a reply (not /compact, /rename or a refused sign-in: type() alone for those).
 * Each wait is bounded by `opts.hungMs` (TURN_HUNG_MS) and logs how long one not done at the first look took.
 */
function fakePrompts(inv, key, live, { hungMs = TURN_HUNG_MS, home = null, why = null } = {}) {
  const screen = async () => (await inv('pty:buffer', key).catch(() => '')) ?? ''
  const idle = (s) => ['ready', 'finished', 'watching', 'background'].includes(s?.status) && s?.turn?.state !== 'running'
  const takesPrompts = async () => {
    const b = await screen()
    return idle(await live()) && b.lastIndexOf('✻ Worked for') >= b.lastIndexOf('(esc to interrupt)')
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
    await inv('pty:write', key, text)
    await sleep(300) // on purpose: the fake reads a typed line before its Enter, as a CLI does
    await inv('pty:write', key, '\r')
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
    console.log(`DIAGNOSTIC hooks that didn't reach Hive: ${home ? (failed.length ? failed.join(' | ') : 'none') : '(its home not given)'}`)
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
 * the Hive under test's own git (#199): Hive refreshes branch status and the Changes tab with `git status`, which holds
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
      const out = Array.isArray(cmd) ? execFileSync('git', cmd, { env: baseEnv(), ...o }) : execSync(`git ${cmd}`, { env: baseEnv(), ...o })
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

/** A git repository with one commit. */
function gitProject(dir, files = { 'a.ts': 'export const a = 1\n' }) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  const run = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: baseEnv() })
  run('init', '-q')
  run('add', '.')
  run('commit', '-qm', 'init')
}

/**
 * The token in a launch's hook auth file, named in its hook commands (`-H "@<file>"`, in Hive's user data: no generated
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

/** A running launch's private folder in the test Hive's user data (its settings, MCP config and hook auth file, #345). */
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

// What still runs from a test's own folder after its Hive closed (#542): folderProcesses.cjs.
// A process by its identity (pid and start time), never by a remembered pid alone (#603).
const { processTree, stopProcessesIn, identify, stillSame, endExactly, endTreeExactly, endChildTree } = require('./folderProcesses.cjs')

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
 * Hive whose agents run the real Codex (#584): give it as PATH in hiveEnv. Codex runs its commands in PowerShell 7 where
 * it finds one, and its sandbox can't start the Store's while any other process of that package runs on the machine
 * (#499: a test Hive's terminal, an agent's command), while Windows PowerShell is never refused. leftovers-codex keeps
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
 * Text agents read with its cards named as before keys (#1219): "AL-1 (#1)" becomes "#1", so a suite's checks of card
 * numbers stay as they were; each suite checks the keyed form itself (KEYED).
 */
const unkey = (text) => (typeof text === 'string' ? text.replace(/\b[A-Z]{2,4}-\d+ \((#\d+)\)/g, '$1') : text)
/** A card as the window names it (#1221): its key, else #n (a workspace card, or one the board doesn't have). */
async function cardLabel(inv, n) {
  const c = (await inv('tasks:list')).find((x) => x.number === n)
  return c?.key || `#${n}`
}
/** A card named by key with the number the tools take, in agents' text: "AL-1 (#1)". */
const KEYED = /\b[A-Z]{2,4}-\d+ \(#\d+\)/

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
 * Whether a progress run was given an estimate. Not whether time is left: Hive counts the estimate down as the run goes
 * (timeLeft), so a run that outlasts it ends with 0, while one never given an estimate keeps null.
 */
function hadEstimate(run) {
  return typeof run?.estimateMs === 'number'
}

/**
 * Haiku asked for Auto (#129, #234): what the installed Claude Code says about Haiku and Auto (its catalog), the mode
 * it then showed itself (modeObserved: its footer, a hook; never the mode asked for at launch) and the mode Hive shows.
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
 * Settings → Assistant's warning about Auto with Haiku (#129): there exactly when the CLI says Auto isn't offered
 * (saying the session runs in Manual), none when it says it is, the shipped guess ("may not offer") when it doesn't say.
 * Opens Settings → Assistant (Ctrl+,), waits for its model and mode defaults, then for the warning to be as it should
 * (the window may still be taking in what the CLI said: the shipped guess first). Returns [ok, what it found].
 */
async function haikuAutoCaveat(page, autoOffered, timeoutMs = 10000) {
  await page.keyboard.press('Control+,')
  const nav = page.locator('.settings-nav .row', { hasText: 'Assistant' }).first()
  await nav.waitFor({ timeout: timeoutMs })
  await nav.click()
  await page.locator('.assistant-defaults').first().waitFor({ timeout: timeoutMs })
  const caveat = () => page.locator('.mode-caveat', { hasText: 'Auto with Haiku' }).allInnerTexts()
  const right = (c) => (autoOffered === true ? !c.length : autoOffered === false ? c.length === 1 && /doesn't offer Auto with Haiku.*runs in Manual/.test(c[0]) : c.length === 1 && /may not offer Auto with Haiku/.test(c[0]))
  const ok = !!(await until(async () => right(await caveat()), timeoutMs))
  return [ok, JSON.stringify(await caveat())]
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

/** Opens the project's settings from the header's ⋯ (#974: Settings left the tab strip), and waits for them. */
async function openProjectSettings(page, ms = 10000) {
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  await page.locator('.menu .menu-item', { hasText: 'Project Settings' }).click()
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

module.exports = { unkey, KEYED, cardLabel, readCard, writeCard, addMenuRun, agentCount, agentMenu, agentsMenu, agentsMenuRun, menuEntry, openMoreTab, openProjectSettings, paneHeader, showAgent, ROOT, ELECTRON, WORK, CODEX_HOME, CLAUDE_TEST_HOME, TRASH, TEST_GIT_IDENTITY, trashed, tidyUp, ownClaudeHome, probeDir, hiveEnv, childEnv, baseEnv, git, GIT_LOCKED, plainText, trustChoice, haikuAutoMode, haikuAutoCaveat, sleep, port, until, hoverTip, quitWatch, appReady, openWorkspace, hadEstimate, fitWindow, enableProviders, fakeClaude, launch, waitForProvider, addAgent, soloAgent, ptyKey, acceptClaudeTrust, acceptRelaunchTrust, withFileLock, trustForCodex, gitProject, codexSignedIn, pathWithoutStoreAliases, launchDir, launchHook, codexHook, processTree, stopProcessesIn, identify, stillSame, endExactly, endTreeExactly, endChildTree, processRunning, testExecutable, keepPackagedQuiet, PACKAGED_ARGS, NO_UPDATE_CHECK, noUpdateChecks, updateChecksLogged, samplePng, environmentProblem, environmentProblems, storePwshRefusals, stepVerdict, checked, cliStep, sendPrompt, TURN_HUNG_MS, fakePrompts, skip }
