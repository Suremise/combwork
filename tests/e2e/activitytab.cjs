// The Activity tab (#1254, HI-1743): what runs now, a tab per running agent, each its current work as a list: its card
// in progress as a header (or its session), Now (its prompt, then the tool call under way, or thinking or writing),
// subagents and background tasks, processes. Nothing past: a session of an earlier card isn't shown. HB1 runs the fake
// Claude Code on a card in Doing (a turn running a command through cmd /c with a token on its command line, then a
// background subagent; two processes it leaves running); a sub-session of its turn gains a tool call while live; HB2 runs
// on no card (a solo agent); the others don't run. The tab opens frozen: what comes meanwhile is counted in the pill, not
// drawn; Refresh takes a new snapshot; Play goes live (the command that ended fades out and leaves, the subagent comes);
// shown again after another view it is frozen again. No spinners: working is a pulse. The agent's own processes (its
// CLI, its terminal, hive-mcp.js) show only on request; a command shows as given. Hide finished (on by default) hides the
// agents with nothing running; Activity in an agent's menu opens its tab, filtered, frozen; a card in progress has
// Activity in its dialog and its menu, opening the workspace level on its builder (HI-1664, activityworkspace covers it);
// a finished card has none. Details show a prompt with its
// secret masked; a process the agent left running ends from its details after a confirmation, its CLI has no End
// Process. Both themes. Fake Claude Code only (no sign-in, no tokens). Dev build, throwaway profile, workspace and CLI
// homes; quiet.
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
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: AGENTS }))
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
    const one = await inv('tasks:create', { title: 'Card one', project: 'alpha', agent: 'hb1', column: 'doing' })
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
    const node = (kind, text) => page.locator(`.activity-row.act-${kind}`, text ? { hasText: text } : {})
    const tabsShown = async () => page.locator('.activity-agent-tab').evaluateAll((els) => els.map((e) => e.dataset.agent))
    const refresh = () => head.getByRole('button', { name: 'Refresh', exact: true }).click()
    const list = page.locator('.activity-list')
    // The snapshot is of the tab's opening: refreshed (as a user would) until it has the command.
    check('the tab opens with what runs: the command among the processes', !!(await lib.until(async () => {
      if ((await node('process', 'setTimeout').count()) > 0) return true
      await refresh()
      return false
    }, HUNG_MS, 500)))
    check('a tab per agent with something running: HB1 only (Hide finished, on by default)', JSON.stringify(await tabsShown()) === '["hb1"]', JSON.stringify(await tabsShown()))
    const hb1Tab = page.locator('.activity-agent-tab[data-agent="hb1"]')
    check("…with its state mark and its card's key", (await hb1Tab.locator('.state-mark').count()) === 1 && /\w+-\d+/.test(await hb1Tab.innerText()), await hb1Tab.innerText())
    const cardHead = page.locator('.activity-card-head')
    check('its card in progress is the header, a link to it; no card or agent rows', /Card one/.test(await cardHead.innerText()) && (await cardHead.locator('.activity-card-key').count()) === 1 && (await page.locator('.activity-row.act-card, .activity-row.act-agent').count()) === 0, await cardHead.innerText())
    const groups = async () => page.locator('.activity-group').evaluateAll((els) => els.map((e) => e.dataset.group))
    check('then Now (its turn), then its processes, top to bottom', JSON.stringify(await groups()) === '["now","processes"]' && (await node('turn', 'shell:').count()) === 1, JSON.stringify(await groups()))
    check('nothing past: no earlier card, no earlier session', !/earlier card|Building the earlier/.test(await list.innerText()))
    const titles = async () => page.locator('.activity-row.act-process .activity-row-title').allInnerTexts()
    check("the command as given: a cmd /c wrapper shows what it runs, never 'cmd d s c'", (await titles()).some((t) => /^node -e "?setTimeout/.test(t)) && !(await titles()).some((t) => t.startsWith('cmd d s c')), JSON.stringify(await titles()))
    check("the agent's own plumbing is hidden: no CLI, no terminal host, no hive-mcp.js; the processes it left running show", !(await titles()).some((t) => /fake-claude\.cjs|powershell|hive-mcp/.test(t)) && (await titles()).filter((t) => /linger/.test(t)).length === 2, JSON.stringify(await titles()))
    check("a process's command line shows with its token masked", !(await list.innerText()).includes(GH))
    check('no spinner anywhere; working is a pulse', (await page.locator('.activity-tab .spin, .activity-tab .codicon-loading').count()) === 0 && (await page.locator('.activity-tab .activity-pulse').count()) > 0)

    // --- Frozen: the command ends and nothing changes; the pill counts what came.
    const live = head.locator('.activity-live')
    check('it opens frozen (Play offered, not pressed)', (await live.getAttribute('aria-pressed')) === 'false' && /Play/.test(await live.innerText()))
    const drawnCommand = await node('process', 'setTimeout').count()
    await lib.until(async () => !(await commandRuns()), HUNG_MS, 250)
    const pill = head.locator('.activity-pill')
    check('frozen, what came since waits in the pill', !!(await lib.until(async () => /update/.test(await pill.innerText().catch(() => '')), HUNG_MS, 250)), await pill.innerText().catch(() => ''))
    check('…and it holds: the command that ended is still shown, as it was', drawnCommand > 0 && (await node('process', 'setTimeout').count()) === drawnCommand && (await page.locator('.activity-row.act-gone').count()) === 0)
    await page.mouse.move(5, 5)
    await shoot('1-frozen-dark')

    // --- Play: live; the command fades out and leaves, the background subagent comes.
    await live.click()
    check('Play goes live', (await live.getAttribute('aria-pressed')) === 'true' && /Pause/.test(await live.innerText()))
    check('live, the command that ended leaves', !!(await lib.until(async () => (await node('process', 'setTimeout').count()) === 0, HUNG_MS, 100)))
    check('…and the background subagent shows under Subagents, a plain icon with its name (no pulse)', !!(await lib.until(async () => (await node('task').count()) === 1, HUNG_MS, 250)) && (await node('task').locator('.activity-pulse').count()) === 0 && JSON.stringify(await groups()) === '["now","subagents","processes"]', JSON.stringify(await groups()))
    // HR6's round 1: a subagent's transcript read again while it runs. A sub-session of HB1's running one (as Claude Code
    // records a subagent's), its tool call under way; then it goes on to another.
    const parent = (await liveOf('hb1')).sessionId
    const subId = randomUUID()
    const subFile = path.join(transcripts, `${subId}.jsonl`)
    const subLine = (o) => fs.appendFileSync(subFile, line({ sessionId: subId, cwd: alpha, timestamp: new Date().toISOString(), ...o }) + '\n')
    subLine({ type: 'user', message: { role: 'user', content: 'Look for the race' } })
    subLine({ type: 'assistant', requestId: 'sr1', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_sub1', name: 'Grep', input: { pattern: 'race' } }], usage: { input_tokens: 10, output_tokens: 5 } } })
    const subs = sessionsOf(alpha)
    subs.sessions.push({ id: subId, agent: 'claude-code', agentId: 'hb1', agentName: 'HB1', name: 'A subagent', cwd: alpha, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), archived: false, sub: { parentId: parent, kind: 'sub-agent' } })
    putSessions(alpha, subs)
    const subRow = node('session', 'A subagent')
    check("a running subagent shows with its tool call under way", !!(await lib.until(async () => /Grep/.test(await subRow.innerText().catch(() => '')), HUNG_MS, 250)), await subRow.innerText().catch(() => ''))
    subLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub1', content: 'found', is_error: false }] } })
    subLine({ type: 'assistant', requestId: 'sr2', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_sub2', name: 'Read', input: { file_path: 'src/race.ts' } }], usage: { input_tokens: 10, output_tokens: 5 } } })
    check('…and its next tool call as its transcript grows, read again live', !!(await lib.until(async () => /Read/.test(await subRow.innerText().catch(() => '')), HUNG_MS, 250)), await subRow.innerText().catch(() => ''))
    await page.mouse.move(5, 5)
    await shoot('2-live-subagent-dark')
    // HR6's round 2: its state is its own. It replies and is done, no pulse, while HB1 and its background subagent go on.
    subLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub2', content: 'read', is_error: false }] } })
    subLine({ type: 'assistant', requestId: 'sr3', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The race is in src/race.ts.' }], usage: { input_tokens: 10, output_tokens: 5 } } })
    check('a subagent that replied is Done, no pulse, while its parent goes on', !!(await lib.until(async () => /Done/.test(await subRow.innerText().catch(() => '')) && (await subRow.locator('.activity-pulse').count()) === 0, HUNG_MS, 250)) && (await node('task').count()) === 1, await subRow.innerText().catch(() => ''))
    // HR6's round 1: shown again after another view, it is a new opening: frozen, though it was live.
    await page.locator('.activity-btn[aria-label="Settings"]').click()
    await lib.until(async () => !(await list.isVisible().catch(() => false)), HUNG_MS, 100)
    await page.locator('.activity-btn[aria-label="Projects"]').click()
    check('opened again from another view, it is frozen again (Play offered)', !!(await lib.until(async () => (await live.isVisible().catch(() => false)) && (await live.getAttribute('aria-pressed')) === 'false', HUNG_MS, 250)))

    // --- Details: the running turn's prompt (its token masked); a process it left running ends; the CLI has no End Process.
    await node('turn').first().click()
    const details = page.locator('.activity-details')
    const pre = details.locator('.activity-pre').first()
    await lib.until(async () => /shell:/.test(await pre.innerText().catch(() => '')), HUNG_MS)
    check("the turn's details show its prompt, the token masked", !(await pre.innerText()).includes(GH), (await pre.innerText()).slice(0, 200))
    const endButton = details.locator('button', { hasText: 'End Process' })
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
    // Its own processes on request: its CLI among them, with no End Process.
    const own = page.locator('.activity-own input')
    await own.check()
    check("Show the agent's own processes: its CLI too", !!(await lib.until(async () => (await titles()).some((t) => /fake-claude\.cjs/.test(t)), HUNG_MS, 250)), JSON.stringify(await titles()))
    await node('process', 'fake-claude.cjs').first().click()
    await lib.until(async () => /fake-claude/.test(await details.innerText().catch(() => '')), HUNG_MS)
    check("the agent's CLI has no End Process", (await endButton.count()) === 0)
    await details.getByRole('button', { name: 'Close details' }).click()
    await own.uncheck()

    // --- A solo agent: HB2 runs on no card; its tab is its work alone, thinking.
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
    check('…a solo agent: its session as the header, no card; working with no tool call: Thinking…', !!(await lib.until(async () => {
      if ((await page.locator('[data-doing="thinking"]').count()) === 1 && !/Card one/.test(await cardHead.innerText().catch(() => ''))) return true
      await refresh()
      return false
    }, HUNG_MS, 500)), await list.innerText().catch(() => ''))
    await page.mouse.move(5, 5)
    await shoot('3-solo-dark')

    // --- Hide finished off: every agent has a tab; one not running says so.
    await head.locator('.activity-hide input').uncheck()
    check('Hide finished off: a tab for every agent, in pane order', !!(await lib.until(async () => JSON.stringify(await tabsShown()) === JSON.stringify(AGENTS.map((a) => a.id)), HUNG_MS, 250)), JSON.stringify(await tabsShown()))
    await page.locator('.activity-agent-tab[data-agent="hr3"]').click()
    check('…an agent not running: Not running', !!(await lib.until(async () => /Not running/.test(await list.innerText().catch(() => '')), HUNG_MS, 250)), await list.innerText().catch(() => ''))
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
    // The workspace level (HI-1664), on its builder; the project's tab is as it was.
    const wsTab = page.locator('.activity-workspace .activity-agent-tab[data-agent="hb1"]')
    check("the card dialog's Activity: the workspace level on its builder, frozen", !!(await lib.until(async () => /Card \w+-\d+/.test(await page.locator('.activity-workspace .activity-for-card').innerText().catch(() => '')) && (await wsTab.getAttribute('aria-selected').catch(() => null)) === 'true', HUNG_MS, 250)) && (await page.locator('.activity-workspace .activity-live').getAttribute('aria-pressed')) === 'false')
    await page.locator('.activity-btn[aria-label="Projects"]').click()
    await page.locator('.tab', { hasText: 'Activity' }).click()
    check("…and the project's tab is unchanged: all agents, all cards", !!(await lib.until(async () => /All agents/.test(await agentsPick.innerText().catch(() => '')) && /All cards/.test(await head.locator('.activity-pick').nth(1).innerText().catch(() => '')), HUNG_MS, 250)))
    await hb1Tab.click()

    // --- A long title (HI-1884): the row stays one line, the key and the column whole, only the title cut with "…" and
    // whole in its tooltip; at the normal width and a narrow one, in both themes.
    const LONG = 'Card one: the tray keeps its restart notice after an update restart because the check answers late, and more'
    await inv('tasks:update', one.number, { title: LONG })
    const oneLine = async (theme) => {
      for (const [width, name] of [[1500, 'normal'], [760, 'narrow']]) {
        await lib.fitWindow(app, page, { width, height: 900 })
        const shown = await lib.until(async () => {
          if ((await cardHead.locator('.activity-card-title').getAttribute('title').catch(() => null)) === LONG) return true
          await refresh()
          return false
        }, HUNG_MS, 500)
        const g = await cardHead.evaluate((row) => {
          const box = (sel) => row.querySelector(sel)?.getBoundingClientRect() ?? null
          const title = row.querySelector('.activity-card-title')
          const lineH = parseFloat(getComputedStyle(row).lineHeight) || 18
          return { line: lineH, head: row.getBoundingClientRect().height, key: box('.activity-card-key'), title: box('.activity-card-title'), column: box('.activity-card-column'), keyText: row.querySelector('.activity-card-key')?.textContent ?? '', cut: !!title && title.scrollWidth > title.clientWidth }
        })
        const single = (b) => !!b && b.height < g.line * 1.5
        check(`${theme}, ${name}: the card row is one line, its key and column whole, only the title cut`, !!shown && single(g.key) && single(g.column) && single(g.title) && g.head < g.line * 1.5 + 2 && /^\w+-\d+$/.test(g.keyText.trim()) && g.key.right <= g.title.left && g.title.right <= g.column.left && (name === 'normal' || g.cut), JSON.stringify(g))
        await shoot(`7-one-line-${theme}-${name}`)
      }
      await lib.fitWindow(app, page, { width: 1500, height: 900 })
    }
    await oneLine('dark')

    // --- Light theme.
    await inv('settings:update', { appearance: { theme: 'light' } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', HUNG_MS)
    await hb1Tab.click()
    await page.mouse.move(5, 5)
    await lib.until(async () => /Card one/.test(await cardHead.innerText().catch(() => '')) && (await node('process').count()) > 0, HUNG_MS, 250)
    await shoot('5-light')
    await oneLine('light')
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
