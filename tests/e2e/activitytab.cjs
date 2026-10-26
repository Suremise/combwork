// The Activity tab (#1254, HI-1743): what runs now, a tab per running agent, each its current work as a tree: its card
// in progress (or its session), the latest turn and tool call, background tasks, subagents and processes. Nothing past:
// a session of an earlier card isn't shown. HB1 runs the fake Claude Code on a card in Doing (a turn running a command
// with a token on its command line, then a background subagent; two processes it leaves running); HB2 runs on no card
// (a solo agent); the others don't run. The tab opens frozen: what comes meanwhile is counted in the pill, not drawn;
// Refresh takes a new snapshot; Play goes live (the command that ended fades out and leaves, the subagent comes); Pause
// freezes again. No spinners: working is a pulse. Hide finished (on by default) hides the agents with nothing running;
// Activity in an agent's menu opens its tab, filtered, frozen; a card in progress has Activity in its dialog and its
// menu, on its builder's tab; a finished card has none. Details show a prompt and a process's command line with their
// secrets masked; a process the agent left running ends from its details after a confirmation, its CLI has no End
// Process. Zoom to fit, Levels and Collapse All. Both themes. Fake Claude Code only (no sign-in, no tokens). Dev build,
// throwaway profile, workspace and CLI homes; quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { sessionsOf, putSessions } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'activitytab-profile')
const ws = path.join(lib.WORK, 'activitytab-ws')
const claudeHome = path.join(lib.WORK, 'activitytab-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const now = Date.now()
const ago = (min) => new Date(now - min * 60_000).toISOString()
// Eight agents, as a team has: two run, the others have nothing running.
const AGENTS = ['HB1', 'HB2', 'HB3', 'HB4', 'HR1', 'HR2', 'HR3', 'HR4'].map((n) => ({ id: n.toLowerCase(), name: n, provider: 'claude-code' }))
const GH = `ghp_${'z'.repeat(36)}`
const line = (o) => JSON.stringify(o)
/** A finished session's transcript: one prompt with a Bash call and a reply. */
function transcript(sid, startMin) {
  let t = now - startMin * 60_000
  const at = () => new Date((t += 2000)).toISOString()
  const id = `toolu_${sid.slice(0, 4)}`
  return (
    [
      line({ type: 'user', sessionId: sid, cwd: alpha, timestamp: at(), message: { role: 'user', content: 'Build the earlier card' } }),
      line({ type: 'assistant', sessionId: sid, requestId: 'r1', timestamp: at(), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 10, output_tokens: 5 } } }),
      line({ type: 'user', sessionId: sid, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] } }),
      line({ type: 'assistant', sessionId: sid, requestId: 'r2', timestamp: at(), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 5 } } })
    ].join('\n') + '\n'
  )
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: AGENTS }))
  // The fake Claude Code; as it starts it leaves two processes running in its launch's job (#507's linger).
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  fs.writeFileSync(path.join(claudeHome, 'fake-linger-at-start.txt'), '2')
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const transcripts = path.join(claudeHome, 'projects', alpha.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(transcripts, { recursive: true })

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47931), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const shots = path.join(lib.WORK, 'activitytab-shots')
  fs.mkdirSync(shots, { recursive: true })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const shoot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) })

    // --- HB1's card in Doing; a finished card of HB1's, with its session an hour ago (history: never shown here).
    await inv('tasks:create', { title: 'Card one', project: 'alpha', agent: 'hb1', column: 'doing' })
    const old = await inv('tasks:create', { title: 'An earlier card', project: 'alpha', agent: 'hb1', column: 'done' })
    const S = { old: randomUUID() }
    fs.writeFileSync(path.join(transcripts, `${S.old}.jsonl`), transcript(S.old, 60))
    const file = sessionsOf(alpha)
    file.sessions.push({ id: S.old, agent: 'claude-code', agentId: 'hb1', agentName: 'HB1', name: 'Building the earlier card', cwd: alpha, createdAt: ago(65), lastActiveAt: ago(60), archived: false, cards: [{ number: old.number, title: old.title }] })
    putSessions(alpha, file)

    // --- HB1 running: a command for its turn (a token on its command line), then a background subagent.
    await page.getByText('alpha', { exact: true }).first().click()
    await inv('session:start', alpha, { agentId: 'hb1' })
    const liveOf = async (id) => (await inv('session:live')).find((x) => x.agentId === id) ?? null
    await lib.until(async () => ['ready', 'finished'].includes((await liveOf('hb1'))?.status), HUNG_MS)
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'hb1'), `shell: node -e "setTimeout(()=>{},15000)" ${GH} then subagent 60 then work 90`, { submitted: async () => (await liveOf('hb1'))?.status === 'working' })
    const commandRuns = async () => (await inv('activity:now', alpha)).launches.flatMap((l) => l.processes).some((p) => /setTimeout/.test(p.command ?? p.label))
    await lib.until(commandRuns, HUNG_MS, 250)

    // --- The tab: HB1's tab only (the others have nothing running), its card in progress and what runs in it.
    await page.locator('.tab', { hasText: 'Activity' }).click()
    const head = page.locator('.activity-head')
    const node = (kind, text) => page.locator(`.activity-node.act-${kind}`, text ? { hasText: text } : {})
    const tabsShown = async () => page.locator('.activity-agent-tab').evaluateAll((els) => els.map((e) => e.dataset.agent))
    const refresh = () => head.getByRole('button', { name: 'Refresh', exact: true }).click()
    // The snapshot is of the tab's opening: refreshed (as a user would) until it has the command.
    check('the tab opens with what runs: the command among the processes', !!(await lib.until(async () => {
      if ((await node('process', 'setTimeout').count()) > 0) return true
      await refresh()
      return false
    }, HUNG_MS, 500)))
    check('a tab per agent with something running: HB1 only (Hide finished, on by default)', JSON.stringify(await tabsShown()) === '["hb1"]', JSON.stringify(await tabsShown()))
    const hb1Tab = page.locator('.activity-agent-tab[data-agent="hb1"]')
    check("…with its state mark and its card's key", (await hb1Tab.locator('.state-mark').count()) === 1 && /AL-\d+|#\d+|\w+-\d+/.test(await hb1Tab.innerText()), await hb1Tab.innerText())
    const titles = async () => page.locator('.activity-node').evaluateAll((els) => els.map((e) => `${e.className.match(/act-(\w+)/)[1]}:${e.querySelector('.activity-node-title')?.textContent ?? ''}`))
    const shown = await titles()
    // (The fake's shell step records no tool call: the command is its processes.)
    check('its tree: the card in progress, HB1, its running session and its turn', ['card:', 'agent:HB1', 'session:', 'turn:'].every((t) => shown.some((s) => s.startsWith(t))) && shown.some((s) => s.startsWith('card:') && s.includes('Card one')), JSON.stringify(shown))
    check('nothing past: no earlier card, no earlier session', !shown.some((s) => s.includes('earlier card') || s.includes('Building the earlier')))
    check("…its processes: its CLI, the two it left running, the command", (await node('process').count()) >= 4, String(await node('process').count()))
    check("a process's command line shows with its token masked", !(await page.locator('.activity-tree').innerText()).includes(GH))
    check('no spinner anywhere; working is a pulse', (await page.locator('.activity-tab .spin, .activity-tab .codicon-loading').count()) === 0 && (await page.locator('.activity-tab .activity-pulse').count()) > 0)

    // --- Frozen: the command ends and nothing changes in the tree; the pill counts what came.
    const live = head.locator('.activity-live')
    check('it opens frozen (Play offered, not pressed)', (await live.getAttribute('aria-pressed')) === 'false' && /Play/.test(await live.innerText()))
    const drawnCommand = await node('process', 'setTimeout').count()
    await lib.until(async () => !(await commandRuns()), HUNG_MS, 250)
    const pill = head.locator('.activity-pill')
    check('frozen, what came since waits in the pill', !!(await lib.until(async () => /update/.test(await pill.innerText().catch(() => '')), HUNG_MS, 250)), await pill.innerText().catch(() => ''))
    check('…and the tree holds: the command that ended is still drawn, as it was', drawnCommand > 0 && (await node('process', 'setTimeout').count()) === drawnCommand && (await page.locator('.activity-node.act-gone').count()) === 0)
    await page.mouse.move(5, 5)
    await shoot('1-frozen-dark')

    // --- Play: live; the command fades out and leaves, the background subagent comes; Pause freezes again.
    await live.click()
    check('Play goes live', (await live.getAttribute('aria-pressed')) === 'true' && /Pause/.test(await live.innerText()))
    check('live, the command that ended leaves', !!(await lib.until(async () => (await node('process', 'setTimeout').count()) === 0, HUNG_MS, 100)))
    check('…and the background subagent shows, a plain icon with its name (no pulse)', !!(await lib.until(async () => (await node('task').count()) === 1, HUNG_MS, 250)) && (await node('task').locator('.activity-pulse').count()) === 0)
    await shoot('2-live-subagent-dark')
    await live.click()
    check('Pause freezes again', (await live.getAttribute('aria-pressed')) === 'false')

    // --- Details: the running turn's prompt (its token masked); the CLI has no End Process; a process it left running ends.
    await node('turn').first().click()
    const details = page.locator('.activity-details')
    const pre = details.locator('.activity-pre').first()
    await lib.until(async () => /shell:/.test(await pre.innerText().catch(() => '')), HUNG_MS)
    check("the turn's details show its prompt, the token masked", !(await pre.innerText()).includes(GH), (await pre.innerText()).slice(0, 200))
    const endButton = details.locator('button', { hasText: 'End Process' })
    await node('process', 'fake-claude').first().click()
    await lib.until(async () => /fake-claude/.test(await details.innerText().catch(() => '')), HUNG_MS)
    check("the agent's CLI has no End Process", (await endButton.count()) === 0)
    await node('process', 'linger').first().click()
    await lib.until(async () => (await endButton.count()) === 1, HUNG_MS)
    const pid = Number(/Process id\s+(\d+)/.exec(await details.innerText())?.[1])
    const running = async () => (await inv('activity:now', alpha)).launches.flatMap((l) => l.processes).some((p) => p.pid === pid)
    check('a process it left running has End Process', pid > 0 && (await running()), String(pid))
    await endButton.click()
    await page.getByRole('button', { name: 'End Process…' }).last().click()
    check('confirmed, that process ends', !!(await lib.until(async () => !(await running()), HUNG_MS, 250)), String(pid))
    check('…and the agent still runs', !!(await liveOf('hb1')))
    check("main refuses a process that isn't the agent's", (await inv('activity:endProcess', alpha, 'hb1', process.pid, '1')) === 'notOwn')
    await details.getByRole('button', { name: 'Close details' }).click()

    // --- Zoom to fit, Levels, Collapse All.
    const zoomValue = head.locator('.activity-zoom-value')
    await head.getByRole('button', { name: 'Zoom to Fit (F)' }).click()
    check('Zoom to Fit scales the tree to the tab, never above actual size', !!(await lib.until(async () => Number((await zoomValue.innerText()).replace(/[^\d]/g, '')) <= 100, HUNG_MS, 250)))
    await zoomValue.click()
    await head.locator('.activity-levels').click()
    await lib.menuEntry(page, 'Collapse all turns').click()
    check('Levels: Collapse all turns hides the tool calls under them', !!(await lib.until(async () => (await node('tool').count()) === 0 && (await node('turn').count()) > 0, HUNG_MS, 250)))
    await lib.menuEntry(page, 'Expand all turns').click()
    await page.keyboard.press('Escape')
    await head.getByRole('button', { name: 'Collapse All' }).click()
    check('Collapse All closes them all, down to the card', !!(await lib.until(async () => (await node('session').count()) === 0 && (await node('card').count()) === 1, HUNG_MS, 250)))
    await head.getByRole('button', { name: 'Expand All' }).click()

    // --- A solo agent: HB2 runs on no card; its tab is its session alone.
    await inv('session:start', alpha, { agentId: 'hb2' })
    await lib.until(async () => ['ready', 'finished'].includes((await liveOf('hb2'))?.status), HUNG_MS)
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'hb2'), 'work 60', { submitted: async () => (await liveOf('hb2'))?.status === 'working' })
    const hb2Tab = page.locator('.activity-agent-tab[data-agent="hb2"]')
    check("a running agent's tab comes with a new snapshot", !!(await lib.until(async () => {
      if ((await hb2Tab.count()) === 1) return true
      await refresh()
      return false
    }, HUNG_MS, 500)))
    await hb2Tab.click()
    check('…a solo agent: its session alone, no card', !!(await lib.until(async () => (await node('agent', 'HB2').count()) === 1 && (await node('session').count()) === 1 && (await node('card').count()) === 0, HUNG_MS, 250)), JSON.stringify(await titles()))
    await page.mouse.move(5, 5)
    await shoot('3-solo-dark')

    // --- Hide finished off: every agent has a tab; one not running is its agent alone.
    await head.locator('.activity-hide input').uncheck()
    check('Hide finished off: a tab for every agent, in pane order', !!(await lib.until(async () => JSON.stringify(await tabsShown()) === JSON.stringify(AGENTS.map((a) => a.id)), HUNG_MS, 250)), JSON.stringify(await tabsShown()))
    await page.locator('.activity-agent-tab[data-agent="hr3"]').click()
    check('…an agent not running: the agent alone', !!(await lib.until(async () => JSON.stringify(await titles()) === '["agent:HR3"]', HUNG_MS, 250)), JSON.stringify(await titles()))
    await page.mouse.move(5, 5)
    await shoot('4-all-agents-dark')
    await head.locator('.activity-hide input').check()

    // --- From an agent's menu: its tab, filtered to it, frozen.
    await live.click()
    await page.locator('.tab', { hasText: 'Session' }).first().click()
    await lib.agentMenu(page, 'HR1')
    await lib.menuEntry(page, 'Activity').click()
    const agentsPick = head.locator('.activity-pick').first()
    check("Activity in an agent's menu: its tab alone, filtered, frozen", !!(await lib.until(async () => /1 agent/.test(await agentsPick.innerText().catch(() => '')) && JSON.stringify(await tabsShown()) === '["hr1"]', HUNG_MS, 250)) && (await live.getAttribute('aria-pressed')) === 'false', JSON.stringify(await tabsShown()))
    await agentsPick.click()
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')

    // --- A card in progress: Activity in its menu and its dialog, on its builder's tab; a finished card has none.
    await page.locator('.tab', { hasText: 'Tasks' }).first().click()
    const cardOne = page.locator('.task-card', { hasText: 'Card one' }).first()
    await cardOne.click({ button: 'right' })
    check("a card in progress has Activity in its menu", (await lib.menuEntry(page, 'Activity').count()) === 1)
    await shoot('6-card-menu-dark')
    await page.keyboard.press('Escape')
    await page.locator('.task-card', { hasText: 'An earlier card' }).first().click()
    const dialogActivity = page.locator('.dialog[role="dialog"]').getByRole('button', { name: 'Activity', exact: true })
    await lib.until(async () => (await page.locator('.dialog[role="dialog"]').count()) > 0, HUNG_MS)
    check('a finished card has no Activity', (await dialogActivity.count()) === 0)
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.dialog[role="dialog"]').count()) === 0, HUNG_MS)
    await cardOne.click()
    await dialogActivity.click()
    const cardsPick = head.locator('.activity-pick').nth(1)
    check("the card dialog's Activity: its builder's tab, filtered to the card, frozen", !!(await lib.until(async () => /1 card/.test(await cardsPick.innerText().catch(() => '')) && (await hb1Tab.getAttribute('aria-selected')) === 'true' && (await node('card', 'Card one').count()) === 1, HUNG_MS, 250)) && (await live.getAttribute('aria-pressed')) === 'false')
    await cardsPick.click()
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')

    // --- Light theme.
    await inv('settings:update', { appearance: { theme: 'light' } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', HUNG_MS)
    await hb1Tab.click()
    await page.mouse.move(5, 5)
    await lib.until(async () => (await node('card').count()) === 1 && (await node('process').count()) > 0, HUNG_MS, 250)
    await shoot('5-light')
    await inv('session:stop', alpha, 'hb1').catch(() => undefined)
    await inv('session:stop', alpha, 'hb2').catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`Screenshots: ${shots}`)
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
