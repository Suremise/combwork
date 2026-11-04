// Isolated checks (#1435, SPEC §16.13): `hive-progress --check <name> --isolated` runs the project's check in a check copy
// of its own at the card's revision. Two fake Claude Code builders share the project folder (Where cards are built: the
// project folder), each on a card; the check is a script the test steers:
// - in the shared folder, another agent's edit while the check runs makes it uncounted; the same check with --isolated,
//   edited under the same way, counts, runs in copies/copy-1 at the card's revision, and its run's details name the copy;
// - with the project's one copy leased (its size set to 1), B2's isolated check waits ("waiting for a check copy"), then
//   runs in copy-1 once B1's has ended and the copy is quiet; its asks while it waited are waits in the metrics, never
//   failures (HI-1831);
// - an isolated check that started a detached process of its own is stopped from the Progress panel: its whole tree ends
//   (the check and what it left), and the copy is used by the next run.
// And HR1's round 1: the first copy's setup held past hive-progress's 5 s request limit (it waits, then runs); the
// launcher route takes only the lease's own agent's own process, once; another project's copy folder gives an agent
// nothing of its lease. Screenshots of the panel with the isolated run and its details, light and dark. Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { shellStderrFile } = require('./fake-claude/shellStderr.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const PORT = Number(lib.port(47843))
const at = (x) => path.join(lib.WORK, `isolatedcheck-${x}`)
const userData = at('profile')
const ws = at('ws')
const claudeHome = at('claude-home')
const tools = at('tools')
const shots = at('shots')
const alpha = path.join(ws, 'alpha')
const control = path.join(tools, 'control.json')
const started = path.join(tools, 'started.jsonl')
const go = path.join(tools, 'go.txt')
const setupGo = path.join(tools, 'setup-go.txt')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const gitIn = (dir, ...a) => execFileSync('git', a, { cwd: dir, env: lib.gitEnv(), encoding: 'utf8' }).trim()
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** What the next check does: `pass`, `wait` (until go.txt), or `spawn` (a detached sleeper of its own, then waits for ever). */
const steer = (mode) => {
  for (const f of [go]) fs.rmSync(f, { force: true })
  fs.writeFileSync(control, JSON.stringify({ mode }))
}
const starts = () => (fs.existsSync(started) ? fs.readFileSync(started, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, tools, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, tools, shots]) fs.mkdirSync(d, { recursive: true })
  // Every read of the agents' input recorded, for typeLine.
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.gitProject(beta, { 'b.ts': 'export const b = 1\n', '.gitignore': '.combwork/\n' })
  lib.git(beta, ['branch', '-M', 'main'])
  // A copy's setup the test holds (the first copy's): until setup-go.txt exists, bounded against a hang.
  const setupScript = path.join(tools, 'setup.js')
  fs.writeFileSync(setupScript, `const fs = require('fs'); const t = Date.now(); const tick = () => { if (fs.existsSync(${JSON.stringify(setupGo)})) process.exit(0); if (Date.now() - t > 120000) process.exit(3); setTimeout(tick, 100) }; tick()\n`)
  const script = path.join(tools, 'check.js')
  fs.writeFileSync(
    script,
    [
      "const fs = require('fs')",
      `const control = ${JSON.stringify(control)}, started = ${JSON.stringify(started)}, go = ${JSON.stringify(go)}`,
      "const c = JSON.parse(fs.readFileSync(control, 'utf8'))",
      'let kid = null',
      "if (c.mode === 'spawn') { const k = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); k.unref(); kid = k.pid }",
      "fs.appendFileSync(started, JSON.stringify({ pid: process.pid, kid, cwd: process.cwd() }) + '\\n')",
      "if (c.mode === 'pass') process.exit(0)",
      "if (c.mode === 'spawn') setInterval(() => {}, 1000)",
      "else { const t = Date.now(); const tick = () => { if (fs.existsSync(go)) process.exit(0); if (Date.now() - t > 120000) process.exit(3); setTimeout(tick, 100) }; tick() }",
      ''
    ].join('\n')
  )
  steer('pass')
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' }) })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    // Cards built in the project folder (shared); the check "quick" before Review, the steered script.
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project', preChecks: ['quick'], commands: { quick: `node "${script}"` } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2' })
    // Beta: another project, with an agent and a check of its own.
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project', preChecks: ['quick'], commands: { quick: `node "${script}"` } } })
    const c1 = await lib.addAgent(inv, beta, { name: 'C1' })
    const live = async (id, project = alpha) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === project.toLowerCase() && s.agentId === id)
    for (const a of [b1, b2]) await inv('session:start', alpha, { agentId: a.id })
    await inv('session:start', beta, { agentId: c1.id })
    check('the agents start', !!(await until(async () => (await live(b1.id))?.status === 'ready' && (await live(b2.id))?.status === 'ready' && (await live(c1.id, beta))?.status === 'ready', HUNG_MS)))
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (id, project = alpha) => {
      const sessionId = (await live(id, project))?.sessionId
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const call = async (token, p, body = {}) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const shells = () => {
      const f = path.join(claudeHome, 'fake-shell.jsonl')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    /**
     * Types a shell command into an agent's fake session, again when a wake of Hive's disturbed it (typeLine): taken once
     * a turn of its starts (the command may be held). Resolves with its record once it has ended.
     */
    const shell = async (id, cmd, project = alpha) => {
      const before = shells().length
      await lib.typeLine(inv, lib.ptyKey(project, id), claudeHome, (await live(id, project))?.agentName, `shell: ${cmd}`, {
        ready: async () => (await live(id, project))?.status !== 'working',
        live: () => live(id, project),
        hungMs: HUNG_MS,
      })
      // Its own record: the first of its command after those there before it was typed (another agent's may come first).
      const index = await until(() => {
        const i = shells().findIndex((x, n) => n >= before && x.cmd === cmd && !taken.has(n))
        return i >= 0 ? i + 1 : null
      }, 120000)
      if (!index) return null
      taken.add(index - 1)
      return shells()[index - 1]
    }
    const taken = new Set()
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const a = (await inv('tasks:create', { title: 'Isolated A', project: 'alpha' })).number
    const b = (await inv('tasks:create', { title: 'Isolated B', project: 'alpha' })).number
    const [keyA, keyB] = [(await card(a)).key, (await card(b)).key]
    const [t1, t2] = [await tokenOf(b1.id), await tokenOf(b2.id)]
    const sa = await call(t1, `/v1/tasks/${encodeURIComponent(keyA)}/start`)
    const sb = await call(t2, `/v1/tasks/${encodeURIComponent(keyB)}/start`)
    check('B1 and B2 start their cards in the project folder', sa.status === 200 && sb.status === 200 && sa.body?.data?.folder?.toLowerCase() === alpha.toLowerCase(), JSON.stringify({ sa: sa.body, sb: sb.body }))
    const revision = gitIn(alpha, 'rev-parse', 'HEAD')
    const quick = async (n, run) => (await inv('tasks:work', n))?.checks.find((c) => c.name === 'quick' && c.run === run)
    const runs = async () => (await inv('progress:snapshot')).runs
    const otherEdit = () => fs.writeFileSync(path.join(alpha, 'a.ts'), 'export const a = 2\n')
    const undoEdit = () => gitIn(alpha, 'checkout', '--', 'a.ts')

    // --- In the shared folder: another agent's edit during the check makes it uncounted.
    steer('wait')
    const shared = shell(b1.id, `hive-progress --check quick --card "${keyA}"`)
    check('the shared-folder check starts in the project folder', !!(await until(() => starts().length === 1, HUNG_MS)) && starts()[0].cwd.toLowerCase() === alpha.toLowerCase(), JSON.stringify(starts()))
    // Edited and undone while it runs (#1654): the folder is clean at its end, so it is the change itself that counts
    // against it (an edit left in place would make it dirty at the end, which its finish now reads before this goes on).
    otherEdit()
    undoEdit()
    fs.writeFileSync(go, 'go')
    const sharedRun = await shared
    check('…it passes', sharedRun?.code === 0, JSON.stringify(sharedRun))
    const sharedId = (await runs()).find((r) => r.check === 'quick' && r.card === a && !r.copy)?.id
    const sharedCheck = await until(() => quick(a, sharedId), HUNG_MS)
    check("…but doesn't count: files changed in the folder while it ran", sharedCheck?.counted === false && sharedCheck.whyNot === 'changed', JSON.stringify(sharedCheck))
    // #1654: hive-progress says so as it ends, naming what changed and the remedy, its exit code the command's.
    const said = 'cw-progress: not counted as check quick: files changed in the folder while it ran (a.ts'
    check('…and hive-progress says why, with what to do', sharedRun.stderr.includes(said) && sharedRun.stderr.includes('or with --isolated'), sharedRun.stderr)

    // --- The same check, isolated: in copies/copy-1 at the card's revision; the same edit doesn't touch it. The first copy's
    // setup is held past hive-progress's 5 s request limit (HR1's round 1): it waits, then runs.
    await inv('project:updateConfig', alpha, { copies: { size: 1 }, slots: { setup: `node "${setupScript}"` } })
    steer('wait')
    const iso = shell(b1.id, `hive-progress --check quick --isolated --card "${keyA}"`)
    const copies = () => inv('copies:list', alpha)
    check("copy-1 is being set up", !!(await until(async () => (await copies()).some((c) => c.name === 'copy-1' && c.state === 'creating'), HUNG_MS)), JSON.stringify(await copies()))
    // Held for longer than one request may take (5 s): the point is the time, so this waits for it (bounded).
    const heldFrom = Date.now()
    await until(() => Date.now() - heldFrom > 7000, HUNG_MS)
    check('…past the request limit, nothing has run and hive-progress still waits', starts().length === 1 && !shells().some((x) => x.cmd.includes('--isolated')))
    fs.writeFileSync(setupGo, 'go')
    check('the isolated check starts in copies\\copy-1', !!(await until(() => starts().length === 2, HUNG_MS)) && /[\\/]copies[\\/]copy-1$/i.test(starts()[1].cwd), JSON.stringify(starts()[1]))
    check('…at the card\'s revision', gitIn(starts()[1].cwd, 'rev-parse', 'HEAD') === revision)
    check('…its copy leased to B1 for the card', !!(await until(async () => (await copies()).some((c) => c.name === 'copy-1' && c.state === 'leased' && c.lease?.card === a && c.lease.agent === b1.id && c.lease.kind === 'check'), HUNG_MS)), JSON.stringify(await copies()))
    const isoRunId = await until(async () => (await runs()).find((r) => r.check === 'quick' && r.copy === 'copy-1' && r.state === 'running')?.id, HUNG_MS)
    // The panel: the run, its Stop, and its details naming the copy.
    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click()
    check('the panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
    const isoRow = panel.locator(`[data-run="${isoRunId}"]`).first()
    check('…the isolated run shows, with Stop', !!(await until(async () => (await isoRow.count()) === 1 && (await isoRow.locator('button[aria-label="Stop this check and everything it started"]').count()) === 1, HUNG_MS)))
    await isoRow.locator('.progress-details-toggle').click()
    check("…its details name the copy", !!(await until(async () => /Copy\s*copy-1/.test((await isoRow.innerText().catch(() => '')) ?? ''), HUNG_MS)), await isoRow.innerText().catch(() => ''))
    await page.mouse.move(5, 5)
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await panel.screenshot({ path: path.join(shots, `isolatedcheck-1-running-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })

    // The launcher route (HR1's round 1): only the lease's own agent, once, and only a process of that agent's own.
    const leaseId = (await copies()).find((c) => c.name === 'copy-1')?.lease?.id
    const after = Date.now()
    const foreign = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, env: lib.baseEnv() })
    const before = Date.now()
    try {
      const asOther = await call(t2, '/v1/progress/isolated', { lease: leaseId, pid: foreign.pid, after, before })
      check("another agent can't put a process in B1's copy's job", asOther.status === 409 && /no such check copy lease/.test(asOther.body?.error ?? ''), JSON.stringify(asOther))
      const notOwn = await call(t1, '/v1/progress/isolated', { lease: leaseId, pid: foreign.pid, after, before })
      check("…nor B1 a process that isn't its own", notOwn.status === 409 && /isn't one of this agent's own/.test(notOwn.body?.error ?? ''), JSON.stringify(notOwn))
      // Its own check's process (in its launch, any time up to now): its lease has its launcher already.
      const second = await call(t1, '/v1/progress/isolated', { lease: leaseId, pid: starts()[1].pid, after: 0, before: Date.now() })
      check('…nor a second launcher in the same lease', second.status === 409 && /takes no launcher now/.test(second.body?.error ?? ''), JSON.stringify(second))
    } finally {
      foreign.kill()
    }
    otherEdit()
    fs.writeFileSync(go, 'go')
    const isoRun = await iso
    undoEdit()
    check('…it passes', isoRun?.code === 0, JSON.stringify(isoRun))
    const isoCheck = await until(() => quick(a, isoRunId), HUNG_MS)
    check('…and counts, isolated, for the card\'s revision', isoCheck?.counted === true && isoCheck.isolated === true && isoCheck.revision === revision, JSON.stringify(isoCheck))
    check('…its copy returned and freed', !!(await until(async () => (await copies()).every((c) => c.state === 'free' && !c.lease), HUNG_MS)), JSON.stringify(await copies()))

    // --- Another project's copy (HR1's round 1): its folder gives B1 nothing of its lease.
    const cardC = (await inv('tasks:create', { title: 'Beta C', project: 'beta' })).number
    const keyC = (await card(cardC)).key
    const t3 = await tokenOf(c1.id, beta)
    const sc = await call(t3, `/v1/tasks/${encodeURIComponent(keyC)}/start`)
    check('C1 starts its card in beta', sc.status === 200, JSON.stringify(sc.body))
    await inv('project:updateConfig', beta, { copies: { size: 1 } })
    steer('wait')
    const betaRun = shell(c1.id, `hive-progress --check quick --isolated --card "${keyC}"`, beta)
    const betaCopy = await until(() => starts().find((x) => /beta[\\/]copies[\\/]copy-1$/i.test(x.cwd))?.cwd, HUNG_MS)
    check("C1's check holds beta's copy-1", !!betaCopy, JSON.stringify(starts()))
    const peek = await call(t1, '/v1/progress/resolve', { folder: betaCopy })
    check("B1 resolving in beta's copy gets its own card, nothing of beta's lease", peek.status === 200 && peek.body?.card === keyA && !JSON.stringify(peek.body).includes(`#${cardC}`) && !JSON.stringify(peek.body).includes(keyC) && !('copy' in (peek.body ?? {})), JSON.stringify(peek))
    const peekNamed = await call(t1, '/v1/progress/resolve', { folder: betaCopy, card: keyA })
    check('…naming its own card there either', peekNamed.status === 200 && peekNamed.body?.card === keyA && !JSON.stringify(peekNamed.body).includes(`#${cardC}`) && !JSON.stringify(peekNamed.body).includes(keyC), JSON.stringify(peekNamed))
    fs.writeFileSync(go, 'go')
    check("C1's check passes", (await betaRun)?.code === 0)

    // --- The one copy leased: B2's isolated check waits for it, then runs there.
    steer('wait')
    const holding = shell(b1.id, `hive-progress --check quick --isolated --card "${keyA}"`)
    check('B1 holds copy-1', !!(await until(() => starts().length === 4, HUNG_MS)))
    // B2's check refused a copy (it says so), not just its turn begun: B1 freeing it before B2 first asks would leave
    // B2 nothing to wait for (HI-1816).
    const b2Stderr = shellStderrFile(claudeHome, (await live(b2.id))?.agentName)
    fs.writeFileSync(b2Stderr, '')
    const waiting = shell(b2.id, `hive-progress --check quick --isolated --card "${keyB}"`)
    check('…B2\'s check waits: nothing of it runs while copy-1 is out', !!(await until(() => fs.existsSync(b2Stderr) && /waiting for a check copy/.test(fs.readFileSync(b2Stderr, 'utf8')), HUNG_MS)) && starts().length === 4, fs.existsSync(b2Stderr) ? fs.readFileSync(b2Stderr, 'utf8') : 'no stderr file')
    fs.writeFileSync(go, 'go')
    const held = await holding
    const waited = await waiting
    check("B1's check ends, then B2's runs in copy-1 and passes", held?.code === 0 && waited?.code === 0 && starts().length === 5 && /copies[\\/]copy-1$/i.test(starts()[4].cwd), JSON.stringify({ held: held?.code, waited, s: starts()[4] }))
    check('…having said it waited for a check copy', /waiting for a check copy/.test(waited?.stderr ?? ''), waited?.stderr)
    const bCheck = await until(async () => (await inv('tasks:work', b))?.checks.find((c) => c.name === 'quick' && c.isolated), HUNG_MS)
    check("…counted for B's card", bCheck?.counted === true, JSON.stringify(bCheck))
    // Its asks while it waited are waits in Performance, not failures (HI-1831): what the view reads, by outcome.
    const resolves = async () => {
      const r = await inv('metrics:query', { scope: { kind: 'workspace' } })
      const out = {}
      for (const part of [r.workspace, ...Object.values(r.projects)].filter(Boolean))
        for (const s of part.api) if (s.route === '/v1/progress/resolve') out[s.outcome] = (out[s.outcome] ?? 0) + s.count
      return out
    }
    const byOutcome = await until(async () => {
      const r = await resolves()
      return r.waiting > 0 ? r : null
    }, HUNG_MS)
    check('…its waits for the copy are recorded as waits, and no resolve as a failure', !!byOutcome && Object.keys(byOutcome).every((o) => o === 'ok' || o === 'waiting'), JSON.stringify(byOutcome))
    // …and Performance shows them so: resolve's row with no failures and its waits apart, the chart's waits in grey.
    await page.locator('.activitybar button[aria-label="Performance"]').click()
    const routesTable = page.locator('.performance-page:visible .data-table', { has: page.locator('th', { hasText: 'Route' }) }).first()
    const resolveRow = routesTable.locator('tbody tr', { hasText: '/v1/progress/resolve' }).first()
    const cells = async () => (await resolveRow.locator('td').allInnerTexts().catch(() => [])).map((x) => x.trim())
    const headers = async () => (await routesTable.locator('th').allInnerTexts().catch(() => [])).map((x) => x.trim())
    const shown = await until(async () => {
      const [h, c] = [await headers(), await cells()]
      // innerText as shown: the headers are upper case.
      const col = (name) => h.findIndex((x) => x.toLowerCase().startsWith(name.toLowerCase()))
      return c.length && col('Waits') >= 0 ? { failed: c[col('Failed')], waits: c[col('Waits')] } : null
    }, HUNG_MS)
    check("…Performance's Agent API table: resolve has no failures, its waits counted apart", shown?.failed === '—' && /^[1-9]/.test(shown?.waits ?? ''), JSON.stringify(shown))
    check('…and the chart has Waits in its legend', (await page.locator('.performance-page:visible .stack-legend', { hasText: 'Waits' }).count()) === 1)
    await page.mouse.move(5, 5)
    await page.locator('.performance-page:visible').screenshot({ path: path.join(shots, 'isolatedcheck-3-performance-waits.png') })
    await page.locator('.activitybar button[aria-label="Projects"]').click()

    // --- Stopped from the panel: the check and the process it started end, and the copy is used again.
    steer('spawn')
    const stopped = shell(b1.id, `hive-progress --check quick --isolated --card "${keyA}"`)
    const s5 = await until(() => starts()[5], HUNG_MS)
    check('a check that starts a detached process of its own runs in copy-1', !!s5 && !!s5.kid && /copy-1$/i.test(s5.cwd) && alive(s5.pid) && alive(s5.kid), JSON.stringify(s5))
    const stopId = await until(async () => (await runs()).find((r) => r.copy === 'copy-1' && r.state === 'running' && r.card === a)?.id, HUNG_MS)
    const stopRow = panel.locator(`[data-run="${stopId}"]`).first()
    await until(async () => (await stopRow.count()) === 1, HUNG_MS)
    await stopRow.locator('button[aria-label="Stop this check and everything it started"]').click()
    check('Stop ends the check and the process it left', !!(await until(() => !alive(s5.pid) && !alive(s5.kid), HUNG_MS)), JSON.stringify({ pid: alive(s5.pid), kid: alive(s5.kid) }))
    const stoppedRun = await stopped
    check('…its run ends stopped, not failed', stoppedRun?.code !== 0 && !!(await until(async () => (await runs()).find((r) => r.id === stopId)?.state === 'stopped', HUNG_MS)), JSON.stringify({ stoppedRun, state: (await runs()).find((r) => r.id === stopId)?.state }))
    check('…and copy-1 is free again', !!(await until(async () => (await copies()).every((c) => c.state === 'free'), HUNG_MS)), JSON.stringify(await copies()))
    steer('pass')
    const next = await shell(b2.id, `hive-progress --check quick --isolated --card "${keyB}"`)
    check('the next isolated check runs in copy-1', next?.code === 0 && /copy-1$/i.test(starts()[6]?.cwd ?? ''), JSON.stringify({ next, s: starts()[6] }))
    await panel.screenshot({ path: path.join(shots, 'isolatedcheck-2-stopped.png') })
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
