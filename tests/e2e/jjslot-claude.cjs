// A real Claude Code session ending in a jj slot leaves the slot quiet (HI-2912): the real app, the pinned jj (npm run
// jj:fetch) on its PATH, a throwaway profile and workspace, and the real Claude Code in its test home (CLAUDE_TEST_HOME,
// claudeHome: 'test'; not signed in there, the suite is skipped, tests/e2e/README.md). A jj card starts for B1 (Haiku)
// in a slot (a jj workspace); B1 runs jj once there with its Bash tool, as its card says (one short turn, tokens); the card is
// committed, submitted, passed and integrated by the test as jjwindow does; B1 is stopped, and the slot must come back
// to the pool by itself (ready, not lent). jj's settle and detach run only once the slot's folder is quiet (slots.ts
// `quiet`, a rename probe), so a process Claude Code left with its working folder there would keep it out: not back,
// the processes naming this run's folders and Combwork's leftovers for B1 are listed, for what held it. The suite never
// probes the folder itself: two rename probes at once can strand a folder under its aside name (slots.ts, HI-1753).
// Each wait on the CLI is a lib.cliStep: a usage limit, sign-in or network failure there makes the suite a SKIP.
const lib = require('./lib.cjs')
const { CLAUDE_TEST_HOME } = require('./runContext.cjs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const { jjDir, portableJj } = require('../jjPortable.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
const exe = portableJj()
if (!exe) {
  console.log("SKIP jjslot-claude: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}
// The test home's sign-in, as Claude Code says it (the runner asks too; this is for running the suite on its own).
const claude = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')].find((f) => fs.existsSync(f)) ?? 'claude'
const status = spawnSync(claude, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30000, env: lib.childEnv({ CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME }) })
let signedIn = true
try {
  signedIn = JSON.parse(status.stdout).loggedIn !== false
} catch {
  // An answer that can't be read: run, and the steps say what is wrong.
}
if (!signedIn) lib.skip(`environment: Claude Code isn't signed in to its test home ${CLAUDE_TEST_HOME} (tests/e2e/README.md)`)

const PORT = Number(lib.port(47780))
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test session (#174).
const work = path.join(lib.WORK, 'jjslot-claude')
const userData = path.join(work, 'profile')
const ws = path.join(work, 'ws')
const shop = path.join(ws, 'shop')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 500)

// jj's and git's config for the fixture and the app alike: no user's, no system's, no autocrlf.
const home = path.join(work, 'home')
const jjConfig = path.join(home, 'jj.toml')
const gitConfig = path.join(home, 'gitconfig')
const toolEnv = () => ({ ...lib.gitEnv({ GIT_CONFIG_GLOBAL: gitConfig, GIT_ATTR_NOSYSTEM: '1', XDG_CONFIG_HOME: home, JJ_CONFIG: jjConfig, NO_COLOR: '1' }) })
const jj = (cwd, ...args) => execFileSync(exe, args, { cwd, env: toolEnv(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

;(async () => {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(jjConfig, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  fs.writeFileSync(gitConfig, `[user]\n\tname = ${lib.TEST_GIT_IDENTITY.name}\n\temail = ${lib.TEST_GIT_IDENTITY.email}\n[core]\n\tautocrlf = false\n`)
  fs.mkdirSync(shop, { recursive: true })
  fs.writeFileSync(path.join(shop, '.gitignore'), '.combwork/\n')
  jj(shop, 'git', 'init', '--colocate')
  fs.writeFileSync(path.join(shop, 'base.txt'), 'base\n')
  jj(shop, 'commit', '-m', 'base')
  jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
  fs.mkdirSync(path.join(shop, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(shop, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], platform: 'jj', workflow: { platform: 'jj', preset: 'solo', options: { target: 'main' }, presetAsked: 'chosen' } }))
  lib.enableProviders(userData, ['claude-code'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.sessions = { ...cfg.settings.sessions, confirmStop: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = { ...toolEnv(), PATH: `${jjDir()};${lib.baseEnv().PATH ?? ''}`, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off' }
  delete env.CW_USER_DATA
  const { app, page, inv } = await lib.launch({ userData, env: { ...env, CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME } })
  let b1 = null
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const opts = await inv('workflow:setOptions', shop, { preset: null, options: { review: 'you', noSelfReview: false, folder: 'slots', finish: 'userIntegrates', target: 'main' } })
    check('shop: you review, cards in slots, you integrate into main', !!opts && !opts.error, JSON.stringify(opts))
    // The project shown, so its agent's terminal is laid out at the window's size (Claude Code's menus redraw for it).
    await page.getByText('shop', { exact: true }).first().click()
    b1 = await lib.addAgent(inv, shop, { name: 'B1', workflowRole: 'builder', model: 'haiku', permissionMode: 'bypassPermissions' })
    const key = lib.ptyKey(shop, b1.id)
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === shop.toLowerCase() && s.agentId === b1.id)
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

    // --- A jj card for B1: a slot of its own (a jj workspace), the real Claude Code started there; one turn running jj.
    const launchMark = lib.combworkLogLines(userData).length
    // What B1 does is its card's (a builder started on a card works on it first): run jj once in its folder, nothing more.
    const description = 'Use the Bash tool once, in your working folder, to run: jj --ignore-working-copy log --no-graph -r @ > jj-ran.txt   Do nothing else: no commit, no submit, no other card or board change. Then reply with the single word DONE.'
    // The slot's folder (the pool's first, slot-a) trusted in the test home, right before Claude Code starts there: Claude
    // Code trusts a folder by its exact path, and writes the file back itself, so a Claude Code another lane starts in
    // the shared home meanwhile can drop the entry (the trust question is then answered below).
    const slotPath = path.join(`${ws}.worktrees`, 'shop', 'slot-a').replace(/\\/g, '/')
    const homeJson = path.join(CLAUDE_TEST_HOME, '.claude.json')
    const homeCfg = fs.existsSync(homeJson) ? JSON.parse(fs.readFileSync(homeJson, 'utf8')) : {}
    homeCfg.projects = { ...homeCfg.projects, [slotPath]: { ...homeCfg.projects?.[slotPath], hasTrustDialogAccepted: true } }
    fs.writeFileSync(homeJson, JSON.stringify(homeCfg, null, 2))
    const n = (await inv('tasks:create', { title: 'Run jj once', description, project: 'shop', agent: b1.id })).number
    const cardKey = (await card(n)).key
    const started = await inv('tasks:move', n, 'doing', { confirm: true, reason: 'jjslot-claude: start' }).catch((e) => ({ error: String(e) }))
    const w1 = await until(async () => {
      const v = await inv('tasks:work', n)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    check(`${cardKey} starts in a jj slot`, !!w1, JSON.stringify({ started, w1 }))
    if (!w1) throw new Error('no slot')
    const slot = path.basename(w1.folder)
    const marker = path.join(w1.folder, 'jj-ran.txt')
    await lib.cliStep('B1 runs jj in its slot', { session: key }, async () => {
      // The slot's trust question, answered once, when it shows (the session starts with the card, after the slot is made):
      // answering again would press Down again and could move the choice back to No.
      const screen = async () => lib.plainText(await inv('pty:buffer', key).catch(() => '')).slice(-1500)
      if (await until(async () => /trust this folder/i.test(await screen()) || lib.combworkToolsConnected(userData, b1.id, launchMark), 90000)) await lib.acceptClaudeTrust(inv, shop, b1.id, 30000)
      const trusted = await until(() => lib.combworkToolsConnected(userData, b1.id, launchMark), 90000)
      check('Claude Code starts in the slot, its Combwork tools connected', !!trusted, await screen())
      check('B1 ran jj there, as its card asks (its Bash tool, in the slot)', !!(await until(() => fs.existsSync(marker), 180000)), await screen())
      check('…and its turn ended', !!(await until(async () => ['ready', 'finished'].includes((await live())?.status), 120000)), JSON.stringify(await live()))
    })

    // --- The card done as jjwindow does it: committed in the slot, submitted with B1's token, passed, integrated.
    fs.rmSync(marker, { force: true })
    fs.writeFileSync(path.join(w1.folder, 'shop.txt'), 'shop work\n')
    jj(w1.folder, 'commit', '-m', 'shop work')
    const P = jj(w1.folder, '--ignore-working-copy', 'log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim()
    // B1's token (its only agent: the one file in the profile's agent-api folder).
    const tokens = path.join(userData, 'agent-api')
    const tokenFile = fs.existsSync(tokens) ? fs.readdirSync(tokens).filter((f) => f.endsWith('.json')).map((f) => path.join(tokens, f)) : []
    const token = tokenFile.length === 1 ? JSON.parse(fs.readFileSync(tokenFile[0], 'utf8')).token : null
    check("B1's Agent API token", !!token, JSON.stringify(tokenFile))
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(cardKey)}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'Done.' }) })
    check('submitted: in Review', res.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ status: res.status, body: await res.json().catch(() => null), column: (await card(n))?.column }))
    await inv('tasks:move', n, 'passed', { confirm: true, reason: 'jjslot-claude: passed' }).catch(() => undefined)
    check('…passed', !!(await until(async () => (await card(n))?.column === 'passed', HUNG_MS)), (await card(n))?.column)
    jj(shop, 'bookmark', 'set', 'main', '-r', P)
    check('…integrated: Done', !!(await until(async () => (await card(n))?.column === 'done', HUNG_MS)), (await card(n))?.column)

    // --- B1 stopped as Combwork stops it (its terminal ended); the slot must come back by itself once its folder is quiet.
    await inv('session:stop', shop, b1.id)
    check('Combwork stops Claude Code', !!(await until(async () => !(await live()) || (await live())?.status === 'exited', 20000)), JSON.stringify(await live()))
    // The pool's retries' pauses grow to 30 s (HI-2906): two of the longest beyond the usual bound, as jjwindow waits.
    const back = await until(async () => {
      const s = (await inv('slots:list', shop)).find((x) => x.name === slot)
      return s && s.state === 'ready' ? s : null
    }, HUNG_MS * 2)
    check('after Done and B1 stopped, the slot is back in the pool (ready, not lent): its folder is quiet', !!back, JSON.stringify(await inv('slots:list', shop)))
    const appLog = path.join(userData, 'logs', 'combwork.log')
    for (const l of (fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8') : '').split(/\r?\n/).filter((x) => /isn't quiet|detaching|detached/.test(x))) console.log(`INFO app: ${l.slice(0, 300)}`)
    if (!back) {
      // What still names this run's folders (read only, nothing ended), and what Combwork lists as B1's leftovers.
      try {
        const ps = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${work.toLowerCase().replace(/'/g, "''")}') } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
        for (const l of ps.split(/\r?\n/).filter(Boolean)) console.log(`INFO process: ${l.slice(0, 400)}`)
      } catch (e) {
        console.log(`INFO process listing failed: ${e}`)
      }
      console.log(`INFO leftovers: ${JSON.stringify((await inv('session:leftovers')).filter((l) => l.agentId === b1.id))}`)
      // What jj and the pool said meanwhile (a write that failed, a stale slot), from the app's log.
      for (const l of (fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8') : '').split(/\r?\n/).filter((x) => /\[(WARN|ERROR)\] \[(slots|jj|slotCards|workspacePort)\]/.test(x))) console.log(`INFO app: ${l.slice(0, 500)}`)
    }
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
