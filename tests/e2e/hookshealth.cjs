// Hooks health (#1336): an agent whose hooks stop reaching Combwork is shown so, instead of a wrong status. Acted out with
// the fake Claude Code, which sends no hook or status line while fake-nohooks-<agent> is in its home, with Combwork's bound
// (Settings → Advanced, Hooks missing: wait) at 3 s:
// - a healthy agent's long silent think (10 s, over three bounds) and an idle one never show it (no false alarms);
// - its hooks turned off mid-session, its next prompt's work (held on screen until the test ends it) with no hook turns
//   its pane to "Status unknown: no hooks
//   from Claude Code" (a stalled mark) with the project's banner saying why and what to do, a Notifications entry
//   once, nothing typed into it (the Agent API says why), and its lane paused: "paused: Builder's hooks aren't arriving";
// - an agent started with its hooks off shows it from its start; a Codex agent (the fake, whose first hook comes with its
//   first prompt) started on a task with its hooks off shows it after that task, watched though it was still starting;
// - a Codex agent whose hooks worked and then stop while it is idle shows it after the next line Combwork types (#1520);
// - Restart session from the banner with working hooks clears it, and the lane goes on.
// Screenshots of the pane and the banner in both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47938))
const userData = path.join(lib.WORK, 'hookshealth-profile')
const ws = path.join(lib.WORK, 'hookshealth-ws')
const claudeHome = path.join(lib.WORK, 'hookshealth-claude-home')
const codexHome = path.join(lib.WORK, 'hookshealth-codex-home')
const shots = path.join(lib.WORK, 'hookshealth-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 150)
const hooksOff = (agent, off) => {
  const f = path.join(claudeHome, `fake-nohooks-${agent}`)
  if (off) fs.writeFileSync(f, '')
  else fs.rmSync(f, { force: true })
}

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const cenv = lib.fakeClaude(userData, claudeHome, [alpha])
  // Codex too: its first hook comes only with its first prompt (a task given at its start, here).
  fs.rmSync(codexHome, { recursive: true, force: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'cw.hooks.missingSeconds': 3 } }, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), ...cenv, CODEX_HOME: codexHome, FAKE_CODEX_VERSION: '0.162.1', CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await inv('project:setActive', alpha, true)
    await lib.waitForProvider(inv)
    await lib.waitForProvider(inv, 'codex')
    await page.getByText('alpha', { exact: true }).first().click()
    const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }

    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    const live = async (a) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === a.id)
    for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await until(async () => (await live(builder))?.status === 'ready' && (await live(reviewer))?.status === 'ready', 45000)))

    // Whether any agent's state ever said its hooks were missing (sampled throughout the healthy part).
    const ever = new Set()
    const sampler = setInterval(async () => {
      try {
        for (const s of await inv('session:live')) if (s.hooksMissing) ever.add(s.agentId)
      } catch {
        // The window is closing.
      }
    }, 100)
    const raw = async (a) => (await inv('pty:buffer', lib.ptyKey(alpha, a.id)).catch(() => '')) ?? ''
    /** Types a prompt and waits until the fake shows it working on it (its screen: hooks may be off). */
    const say = async (a, text) => {
      const mark = (await raw(a)).length
      // Working, or a quick turn already done ("Worked for").
      return lib.sendPrompt(inv, lib.ptyKey(alpha, a.id), text, { submitted: async () => /esc to interrupt|Worked for/.test(lib.plainText((await raw(a)).slice(mark))) })
    }

    // The lane: Builder on a card in Doing, Reviewer reviewing.
    const c = await inv('tasks:create', { title: 'Hooks health', project: 'alpha', column: 'doing', agent: builder.id })
    const lane = await api('POST', '/v1/lanes', { project: 'alpha', builder: 'Builder', reviewer: 'Reviewer', cards: [c.number] })
    check('the lane starts', lane.status === 200, JSON.stringify(lane))
    const laneNow = async () => (await inv('lanes:list')).find((l) => l.builder.id === builder.id)

    // --- Healthy: a long silent think (its prompt's hook came, then nothing for 10 s: over three bounds), and idle.
    check('a long silent think is under way', (await say(builder, 'work 10')) > 0)
    check('it ends finished', !!(await until(async () => (await live(builder))?.status === 'finished', HUNG_MS)))
    check('no false alarm: a long silent think after its prompt hook, nor an idle agent, ever shows its hooks missing', ever.size === 0 && !(await live(reviewer))?.hooksMissing, JSON.stringify([...ever]))
    clearInterval(sampler)

    // --- Builder's hooks stop mid-session: its next prompt, with no hook while its screen shows it working, shows it. The
    // turn holds until the test ends it (holduntil), so Combwork's look sees it working whenever it comes: a condition, not
    // a turn's length.
    hooksOff('Builder', true)
    const runBefore = (await live(builder))?.runId
    const mark = (await raw(builder)).length
    check('a prompt with its hooks off, held at work on screen', (await say(builder, 'holduntil hh-go')) > 0 && /esc to interrupt/.test(lib.plainText((await raw(builder)).slice(mark))))
    const gone = await until(async () => (await live(builder))?.hooksMissing, HUNG_MS)
    // A late hook of a turn that is over (a tool's end of the earlier turn, by that turn's own id as its prompt hook named
    // it) says nothing of this prompt: it stays missing. Its id must be the earlier turn's: one the launch never saw is a
    // turn this prompt may have begun with no prompt hook (HI-2673), so it would show its hooks arrive.
    const hooksLog = () => (fs.existsSync(path.join(userData, 'logs', 'hooks.log')) ? fs.readFileSync(path.join(userData, 'logs', 'hooks.log'), 'utf8').split('\n') : [])
    const earlier = hooksLog().filter((x) => x.includes(`run=${runBefore} `) && / UserPromptSubmit turn=/.test(x)).map((x) => / turn=(\S+)/.exec(x)[1]).at(-1)
    const lh = lib.launchHook(userData, gone && earlier ? (await live(builder)).runId : '')
    const stale = lh && (await fetch(lh.url, { method: 'POST', headers: { Authorization: `Bearer ${lh.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: (await live(builder)).sessionId, cwd: alpha, tool_name: 'Read', tool_use_id: 'toolu_old', tool_input: {}, prompt_id: earlier }) }).then((r) => r.ok, () => false))
    const journaled = await until(() => hooksLog().some((x) => x.includes(`run=${runBefore} `) && /PostToolUse .*stale/.test(x)), HUNG_MS)
    check("a late hook of a turn that is over (the ledger's stale) leaves its hooks missing", !!stale && !!journaled && !!(await live(builder))?.hooksMissing, JSON.stringify({ earlier, stale, journaled, missing: (await live(builder))?.hooksMissing }))
    // Its turn ends once that is seen: this prompt's own end, after the mark.
    fs.writeFileSync(path.join(claudeHome, 'hh-go'), '')
    check('this turn ends on screen', !!(await until(async () => /Worked for/.test(lib.plainText((await raw(builder)).slice(mark))), HUNG_MS)))
    check('its hooks are missing, shown after the prompt', gone?.after === 'prompt', JSON.stringify(gone))
    const header = page.locator('.pane-header-bar', { hasText: 'Builder' }).first()
    check('its pane says its status is unknown', !!(await until(async () => (await header.locator('.pane-status.hooks-missing').count()) === 1 && /Status unknown: no hooks from Claude Code/.test(await header.locator('.pane-status.hooks-missing').innerText()), HUNG_MS)))
    check("the sidebar's project row says so too, not its last status word", !!(await until(async () => /Status unknown: no hooks from Claude Code/.test(await page.locator('.project-row', { hasText: 'alpha' }).first().innerText()), HUNG_MS)), await page.locator('.project-row').first().innerText().catch(() => ''))
    check('its mark is stalled', !!(await until(async () => (await header.locator('.state-mark.stalled').count()) > 0, HUNG_MS)), await header.innerHTML().catch(() => ''))
    await header.click()
    const banner = page.locator('.banner.hooks-missing')
    check("the project's banner says why it may be wrong and what to do, with Restart session", !!(await until(async () => (await banner.count()) === 1 && /Combwork isn't hearing from Claude Code's hooks, so its status may be wrong\..*Restart the session/.test(await banner.innerText()) && (await banner.locator('button', { hasText: 'Restart session' }).count()) === 1, HUNG_MS)), await banner.innerText().catch(() => ''))

    const paused = await until(async () => {
      const l = await laneNow()
      return l?.state === 'paused' && l
    }, HUNG_MS)
    check("its lane is paused, saying whose hooks aren't arriving", paused?.status?.reason === 'hooks' && paused?.status?.agent === 'Builder', JSON.stringify(paused))
    const project = await api('GET', '/v1/projects/alpha')
    const shown = JSON.stringify(project.body ?? {})
    check("the Agent API says its hooks aren't reaching Combwork and it isn't given work", /hooks aren't reaching Combwork, so its status may be wrong and it isn't given work/.test(shown), shown.slice(0, 400))

    // Told once in Notifications.
    await page.locator('.activitybar button[aria-label="Notifications"]').click()
    const told = page.locator('.notif-panel .toast-title', { hasText: /Combwork isn't hearing from .*Builder's hooks/ })
    check('a Notifications entry, once', !!(await until(async () => (await told.count()) === 1, HUNG_MS)), `${await told.count()}: ${await page.locator('.notif-panel').innerText().catch((e) => String(e))}`)
    await page.locator('.notif-panel button[aria-label="Close"]').click()

    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await page.screenshot({ path: path.join(shots, `hookshealth-pane-${theme}.png`), clip: { x: 0, y: 0, width: 1400, height: 260 } })
    }

    // --- An agent started with its hooks off: shown from its start.
    const mute = await lib.addAgent(inv, alpha, { name: 'Mute' })
    hooksOff('Mute', true)
    await inv('session:start', alpha, { agentId: mute.id })
    const muted = await until(async () => (await live(mute))?.hooksMissing, HUNG_MS)
    check('an agent started with its hooks off shows it from its start', muted?.after === 'start', JSON.stringify(muted))
    await inv('session:stop', alpha, mute.id)

    // --- A Codex agent started on a task with its hooks off (its first hook would come with that task): its launch's
    // task is watched from its start, though it is still starting then.
    const cx = await lib.addAgent(inv, alpha, { name: 'Cx', provider: 'codex', permissionMode: 'full-access' })
    fs.writeFileSync(path.join(codexHome, 'fake-nohooks-Cx'), '')
    // What it does with the card it is started on: work held until the test types "g", its Working line on screen.
    fs.writeFileSync(path.join(codexHome, 'fake-wakes-Cx.txt'), 'hold\n')
    // Started on a card (Start on Card, as from the board), whose title is the fake's step: 12 s of work.
    const cxCard = await inv('tasks:create', { title: 'Hold on', project: 'alpha', column: 'todo' })
    const startedCx = await inv('tasks:start', cxCard.number, { kind: 'agent', agentId: cx.id })
    check('the Codex agent starts on its card', startedCx?.agentId === cx.id, JSON.stringify(startedCx))
    const deafCx = await until(async () => (await live(cx))?.hooksMissing, HUNG_MS)
    check("a Codex agent's launch task with no hook after it, at work on its screen: its hooks are missing", deafCx?.after === 'prompt', JSON.stringify(deafCx ?? (await live(cx))))
    await inv('session:stop', alpha, cx.id)

    // --- A Codex agent whose hooks reached Combwork (a turn heard) and then stop while it is idle (#1520: on 23 Oct its hooks'
    // PowerShell went): the next line Combwork types into it, a task's doorbell as a wake's is, shows its hooks missing once
    // the turn that line starts works, though nothing came since.
    const cy = await lib.addAgent(inv, alpha, { name: 'Cy', provider: 'codex', permissionMode: 'full-access' })
    await inv('session:start', alpha, { agentId: cy.id })
    check('a second Codex agent starts', !!(await until(async () => (await live(cy))?.status === 'ready', 45000)))
    check('…and takes a turn with its hooks working', (await say(cy, 'hh-cy healthy')) > 0 && !!(await until(async () => (await live(cy))?.status === 'finished', HUNG_MS)) && !(await live(cy))?.hooksMissing, JSON.stringify(await live(cy)))
    fs.writeFileSync(path.join(codexHome, 'fake-nohooks-Cy'), '')
    const cyCard = await inv('tasks:create', { title: 'Hooks gone', project: 'alpha', column: 'todo' })
    const given = await inv('tasks:start', cyCard.number, { kind: 'agent', agentId: cy.id })
    check('its hooks off while idle, a card started on it: Combwork types its line', given?.agentId === cy.id, JSON.stringify(given))
    const deafCy = await until(async () => (await live(cy))?.hooksMissing, HUNG_MS)
    check('…and the turn it starts, with no hook, shows its hooks missing', ['transcript', 'prompt'].includes(deafCy?.after), JSON.stringify(deafCy ?? (await live(cy))))
    await inv('session:stop', alpha, cy.id)

    // --- Restart session with working hooks clears it, and the lane goes on.
    hooksOff('Builder', false)
    await header.click()
    await until(async () => (await banner.count()) === 1, HUNG_MS)
    await banner.locator('button', { hasText: 'Restart session' }).click()
    const back = await until(async () => {
      const s = await live(builder)
      return s && s.runId !== runBefore && s.status === 'ready' && !s.hooksMissing && s
    }, 45000)
    check('a restart with working hooks clears it', !!back)
    check('the banner goes', !!(await until(async () => (await banner.count()) === 0, HUNG_MS)))
    const resumed = await until(async () => {
      const l = await laneNow()
      return l && l.state === 'active' && l.status?.reason !== 'hooks' && l
    }, HUNG_MS)
    check('its lane goes on', !!resumed, JSON.stringify(await laneNow()))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
