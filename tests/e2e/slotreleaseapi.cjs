// Release Slot through the Agent API and the Hive Assistant (#1561, SPEC §16.10.3): B1's card is lent slot-a, whose
// writer is planted as a run of a Hive that has gone (`slots:test` writer, a process that has ended); B2, a 0.9 agent,
// has its worktree carried as hb2. On the fake Claude Code, the Agent API on:
// 1. GET …/slots/releasable lists hb2 (kept for B2) and slot-a (held by B1's ended run, its Hive gone), for a script
//    and for a project agent of the project.
// 2. Releasing is refused (403) to a project agent and a script, and to the Assistant at Look and advise: nothing changes.
// 3. The Assistant at Control agents: a writer's release without the user's confirmation (400) or naming another run
//    (409) changes nothing; confirmed, slot-a is released and lent to #12 still; hb2 is released with kind left out;
//    then nothing is left to release, and releasing again is refused (409).
// 4. Both releases are in its actions (release-slot), and its panel lists them as Can't be undone (screenshots, light
//    and dark).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1578): B2 is a 0.9 worktree agent on purpose (agents:testLegacy), and slot-a's writer is planted
// through slots:test; a packaged build refuses both test channels.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { spawnSync } = require('child_process')
const runContext = require('./runContext.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const at = (x) => path.join(lib.WORK, `slotreleaseapi-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const shots = at('shots')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const PORT = Number(lib.port(47808))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha, { '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  const env = lib.fakeClaude(userData, home, [alpha, ws, ...['slot-a', 'hb2'].map((s) => path.join(root, s))])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' }, viewport: { width: 1500, height: 900 } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const userToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body, token = userToken) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const op = (o) => inv('slots:test', alpha, o)
    const live = async (projectPath, id) => (await inv('session:live')).find((s) => same(s.projectPath, projectPath) && s.agentId === id) ?? null
    const launches = () => lines(path.join(home, 'fake-launches.jsonl'))
    /** The agent's running session's Agent API token (its launch's). */
    const tokenOf = async (id) => {
      const sessionId = await until(async () => (await live(alpha, id))?.sessionId, HUNG_MS)
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const writerA = () => inv('slots:heldWriter', alpha, 'slot-a')
    const carriedHb2 = async () => (await inv('slots:list', alpha)).find((s) => s.name === 'hb2')?.lease?.kind === 'carried'
    const releasable = (token) => api('GET', '/v1/projects/alpha/slots/releasable', undefined, token)
    const release = (slot, body, token) => api('POST', `/v1/projects/alpha/slots/${slot}/release`, body, token)

    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    // B2: a 0.9 agent with its own worktree, adopted as its carried slot hb2 (as agentapislots does).
    const b2 = await lib.addAgent(inv, alpha, { location: 'new-worktree', name: 'B2', branch: 'hive/hb2', workflowRole: 'builder' })
    const hb2 = (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha)).agents.find((a) => a.id === b2.id)?.worktree?.path
    const carried = hb2 && fs.existsSync(hb2) ? await op({ op: 'carry', agent: b2.id, slot: 'hb2', folder: hb2 }) : null
    check("B2's 0.9 worktree carried as its slot hb2", carried?.kind === 'carried', JSON.stringify(carried))
    const l12 = await op({ op: 'lend', agent: b1.id, card: 12 })
    check("B1's card #12 is lent slot-a", l12?.ok && l12.slot.name === 'slot-a', JSON.stringify(l12))
    // slot-a's writer: a run of B1's in a Hive whose process has ended (a crash), never this Hive.
    const gone = spawnSync(process.execPath, ['-e', ''], { env: runContext.baseEnv() }).pid
    check("slot-a's writer planted: B1's run in a Hive that has gone", (await op({ op: 'writer', slot: 'slot-a', agent: b1.id, run: 'r-crashed', pid: gone, started: 1 })) === true)

    // --- 1. What there is to release, for a script and for a project agent of the project.
    const listed = await releasable()
    check('GET releasable: hb2 kept for B2, slot-a held by B1\'s ended run (its Hive gone, nothing known of its processes)', listed.status === 200 && JSON.stringify(listed.body?.carried) === JSON.stringify([{ slot: 'hb2', agent: 'B2' }]) && listed.body?.held?.length === 1 && listed.body.held[0].slot === 'slot-a' && listed.body.held[0].agent === 'B1' && listed.body.held[0].run === 'r-crashed' && listed.body.held[0].hive === `gone (process ${gone})` && listed.body.held[0].processes === null, JSON.stringify(listed.body))
    await inv('session:start', alpha, { agentId: r1.id })
    const r1Token = await tokenOf(r1.id)
    check('R1 (a project agent) has its token', !!r1Token)
    check('…and lists its own project\'s', (await releasable(r1Token)).status === 200)

    // --- 2. Refused to a project agent, a script, and the Assistant at Look and advise.
    const confirm = { slot: 'slot-a', run: 'r-crashed' }
    const byAgent = await release('slot-a', { kind: 'writer', confirm }, r1Token)
    check("a project agent's release is refused (403), saying whose it is", byAgent.status === 403 && /user/.test(byAgent.body?.error ?? ''), JSON.stringify(byAgent.body))
    const byScript = await release('slot-a', { kind: 'writer', confirm })
    check("a script's release is refused (403)", byScript.status === 403, JSON.stringify(byScript.body))
    await inv('session:stop', alpha, r1.id)
    const assistantHome = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    await until(async () => {
      const s = await live(assistantHome, 'assistant')
      if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(assistantHome, 'assistant'), '\r')
      return s?.status === 'ready'
    }, HUNG_MS)
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const assistant = (await until(() => fs.existsSync(tokenFile), HUNG_MS)) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token : null
    check('the Assistant has its token', !!assistant)
    await inv('settings:update', { assistant: { control: 'look' } })
    check('at Look and advise the Assistant lists them', (await releasable(assistant)).body?.held?.length === 1)
    const looked = await release('slot-a', { kind: 'writer', confirm }, assistant)
    check("…but its release is refused (403)", looked.status === 403, JSON.stringify(looked.body))
    check('nothing changed: slot-a still held, hb2 still kept for B2', (await writerA())?.run === 'r-crashed' && (await carriedHb2()))

    // --- 3. The Assistant at Control agents.
    await inv('settings:update', { assistant: { control: 'agents' } })
    const noConfirm = await release('slot-a', { kind: 'writer' }, assistant)
    check("a writer's release without the user's confirmation is refused (400), saying what to pass", noConfirm.status === 400 && /confirm/.test(noConfirm.body?.error ?? ''), JSON.stringify(noConfirm.body))
    const both = await release('slot-a', {}, assistant)
    check('kind left out (slot-a has only its writer): it still needs the confirmation (400)', both.status === 400, JSON.stringify(both.body))
    const wrongRun = await release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-other' } }, assistant)
    check('one naming another run is refused (409): the slot changed since it was shown', wrongRun.status === 409 && /changed meanwhile/.test(wrongRun.body?.error ?? ''), JSON.stringify(wrongRun.body))
    check('…slot-a still held', (await writerA())?.run === 'r-crashed')
    const freed = await release('slot-a', { kind: 'writer', confirm }, assistant)
    check('confirmed: slot-a is released', freed.status === 200 && freed.body?.kind === 'writer' && freed.body.slot === 'slot-a' && freed.body.agent === 'B1', JSON.stringify(freed.body))
    check('…no writer, still lent to #12', !!(await until(async () => !(await writerA()) && (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')?.lease?.card === 12, HUNG_MS)))
    const hb2Freed = await release('hb2', {}, assistant)
    check('hb2 is released with kind left out (only its carried lease)', hb2Freed.status === 200 && hb2Freed.body?.kind === 'carried' && hb2Freed.body.agent === 'B2', JSON.stringify(hb2Freed.body))
    check('…no longer kept for B2', !!(await until(async () => !(await carriedHb2()), HUNG_MS)))
    const after = await releasable(assistant)
    check('nothing left to release', after.body?.carried?.length === 0 && after.body?.held?.length === 0, JSON.stringify(after.body))
    const again = await release('hb2', {}, assistant)
    check('releasing again is refused (409)', again.status === 409, JSON.stringify(again.body))

    // --- 4. In its actions, and in its panel as Can't be undone.
    const actions = await inv('assistant:actions')
    const released = actions.filter((x) => x.ok && x.kind === 'release-slot' && x.project === 'alpha')
    check('both releases are in its actions, each naming whose it was', released.length === 2 && released.some((x) => x.agent?.id === b1.id) && released.some((x) => x.agent?.id === b2.id), JSON.stringify(actions.map((x) => [x.kind, x.ok, x.text])))
    const panel = () => page.locator('.assistant-panel')
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Alt+I')
    const link = panel().locator('.assistant-done-link')
    await until(async () => (await link.count()) === 1, HUNG_MS)
    await link.click()
    const rows = panel().locator('.assistant-change-group').first().locator('.assistant-action[data-status="final"]')
    const inPanel = await until(async () => {
      const t = await panel().locator('.assistant-change-group').first().innerText().catch(() => '')
      return (await rows.count()) === 2 && /Released slot-a in alpha from B1's ended run/.test(t) && /Released hb2 in alpha: no longer kept for B2/.test(t) ? t : null
    }, HUNG_MS)
    check("its panel lists both releases, each Can't be undone", !!inPanel, await panel().innerText().catch(() => ''))
    // Each row's tooltip says why (the newest first: hb2's), in both themes for the screenshots.
    const why = /A slot it released isn.t kept or held again: the next work that needs a slot may take it\./
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      for (const i of [0, 1]) {
        await page.mouse.move(5, 5)
        const tip = await lib.hoverTip(page, rows.nth(i), (t) => why.test(t), HUNG_MS)
        check(`…row ${i + 1}'s tooltip says why undo leaves it (${theme})`, why.test(tip), tip)
      }
      await page.screenshot({ path: path.join(shots, `slotreleaseapi-panel-${theme}.png`) })
    }
    await page.mouse.move(5, 5)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
