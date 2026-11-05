// 24 agents at once (#562), on fake Claude Code agents: this workspace's Maximum agents (HI-2001) raised to 24, its 24 agents
// added and all started (a 25th refused); 23 of them each reporting a run through hive-progress, which the Progress
// panel lists (the folded strip's bars and "+N" counting them all), while the 24th watches every working agent (more
// than the 20 a watch took before), woken when they finish; Settings → Advanced's note on what more agents cost,
// measuring the 24 running agents' memory. Screenshots of the session, the panel and the note. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'agents24-profile')
const ws = path.join(lib.WORK, 'agents24-ws')
const claudeHome = path.join(lib.WORK, 'agents24-claude-home')
const crowd = path.join(ws, 'crowd')
const PORT = Number(lib.port(47875))
const N = 24
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(crowd)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([crowd.toLowerCase()]))
  // What each run is: it lasts until the release file exists (3 minutes at the most, in case).
  const release = path.join(claudeHome, 'release-runs')
  const holder = path.join(claudeHome, 'hold.cjs')
  fs.writeFileSync(holder, "const fs = require('fs'); const f = process.argv[2]; setInterval(() => fs.existsSync(f) && process.exit(0), 200); setTimeout(() => process.exit(0), 180000)\n")
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1600, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const lives = async () => (await inv('session:live')).filter((s) => s.projectPath.toLowerCase() === crowd.toLowerCase())
    const live = async (id) => (await lives()).find((s) => s.agentId === id)
    const until = (fn, ms) => lib.until(fn, ms)
    const wakes = (agent) => {
      const f = path.join(claudeHome, 'fake-wakes.jsonl')
      return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
    }
    /** Types a prompt into an agent (as the user does), Enter included. */
    const say = async (id, text) => {
      // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
      await lib.typeLine(inv, lib.ptyKey(crowd, id), claudeHome, null, text, { live: () => live(id) })
    }
    const openRuns = async () => (await inv('progress:list')).filter((r) => r.finishedAt === null && r.projectPath?.toLowerCase() === crowd.toLowerCase())

    // --- 24 agents: the workspace allows them, and all of them start.
    await page.getByText('crowd', { exact: true }).first().click()
    await lib.setMaxAgents(inv, N, 'workspace')
    const agents = []
    for (let i = 1; i <= N; i++) agents.push(await lib.addAgent(inv, crowd, { name: `W${i}` }))
    const refused = await inv('agents:add', crowd, { location: 'project', provider: 'claude-code' }).then(() => '', (e) => String(e.message ?? e))
    check('24 agents added; a 25th refused', agents.length === N && /up to 24 agents/.test(refused), refused)
    for (const a of agents) await inv('session:start', crowd, { agentId: a.id })
    const ready = await until(async () => (await lives()).filter((s) => s.status === 'ready').length === N, 180000)
    check('all 24 start', !!ready, JSON.stringify((await lives()).map((s) => s.status)))
    await page.screenshot({ path: path.join(lib.WORK, 'agents24-1-running.png') })

    // --- 23 of them each report a run through hive-progress; the 24th watches them all.
    const workers = agents.slice(0, N - 1)
    const watcher = agents[N - 1]
    for (const [i, a] of workers.entries()) await say(a.id, `shell: hive-progress --title "Run ${i + 1}" -- node "${holder}" "${release}"`)
    check('23 runs open in the Progress panel, one per agent', !!(await until(async () => (await openRuns()).length === N - 1, HUNG_MS)), String((await openRuns()).length))
    const runs = await openRuns()
    check('…each its own agent', new Set(runs.map((r) => r.agentName)).size === N - 1, runs.map((r) => r.agentName).join(','))
    check('all 23 are working', !!(await until(async () => (await lives()).filter((s) => s.status === 'working').length === N - 1, HUNG_MS)))
    // The folded strip: a bar for the newest few, "+N" for the rest, all 23 counted.
    const rail = page.locator('.progress-rail')
    const strip = async () => ({ bars: await rail.locator('.progress-mini').count(), more: Number((await rail.locator('.progress-more').getAttribute('data-more').catch(() => '0')) ?? 0) })
    check('the folded strip counts all 23: its bars and "+N"', !!(await until(async () => { const s = await strip(); return s.bars > 0 && s.bars + s.more === N - 1 }, HUNG_MS)), JSON.stringify(await strip()))
    await page.locator('.xterm').first().click().catch(() => undefined)
    await page.keyboard.press('Control+Alt+P')
    const panel = page.locator('.progress-panel')
    check('the open panel lists all 23 runs', !!(await until(async () => (await panel.locator('.progress-run').count()) === N - 1, HUNG_MS)), String(await panel.locator('.progress-run').count()))
    await page.screenshot({ path: path.join(lib.WORK, 'agents24-2-progress.png') })

    // Every working agent, no names: 23 (a watch took at most 20 before #562).
    await say(watcher.id, `hive cw_wait_for_agents ${JSON.stringify({ wake: true })}`)
    check('the 24th watches every working agent', !!(await until(async () => (await live(watcher.id))?.status === 'watching', HUNG_MS)), (await live(watcher.id))?.status)
    const status = (await api('GET', '/v1/projects/crowd')).body?.agents?.find((a) => a.name === `W${N}`)
    check('…all 23 of them', status?.watching?.agents?.length === N - 1, JSON.stringify(status?.watching))

    // --- Settings → Version Control → Workspace defaults (HI-2001): Maximum agents' note measures the running agents.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Version Control' }).click()
    await page.locator('.settings-group[data-section="workflow"] [role="tab"][data-setting-tab="workflow.workspaceDefaults"]').click()
    // One form per version control (None, Git), the one shown has the note.
    const row = page.locator('.workflow-option[data-option="maxAgents"]:visible').first()
    const note = row.locator('[data-note="many-agents"]')
    const noteText = async () => ((await note.count()) ? await note.innerText() : '')
    check("Maximum agents' note measures the 24 running agents, and this computer", !!(await until(async () => /Your 24 running agents take [\d.]+ [GM]B now \(about \d+ MB each\); this computer has [\d.]+ GB of memory/.test(await noteText()), HUNG_MS)), await noteText())
    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(lib.WORK, 'agents24-3-note.png') })
    console.log(`  ${await noteText()}`)

    // --- The runs end: the watcher is woken, the agents' turns end and the panel's runs finish.
    fs.writeFileSync(release, '')
    check('the watcher is woken as they finish', !!(await until(async () => wakes(`W${N}`).some((w) => /^\[CW\] .*W\d+.* finished/.test(w)), 120000)), JSON.stringify(wakes(`W${N}`)))
    check('no run is left open', !!(await until(async () => (await openRuns()).length === 0, 120000)), String((await openRuns()).length))
    check('every worker is idle again', !!(await until(async () => (await lives()).filter((s) => ['ready', 'finished'].includes(s.status)).length >= N - 1, 120000)))
  } finally {
    await app.close().catch(() => undefined)
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
