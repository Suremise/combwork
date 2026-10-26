// The Activity tab (#1254): a project's live work as a tree, card → agent → session → turn → tool call, with subagents and
// processes. Fixture sessions on cards (in the last 24 hours, and one older, left out) and an agent running the fake
// Claude Code (a turn running a command with a token on its command line, a background subagent, two processes it
// leaves running): the tree files them in place, the running agent first; a session opens to its turns and a turn to its
// tool calls; details show a prompt and a tool call's input whole, as written (a multiline prompt, an input past round
// 1's cut), and a process's command line, each with its secret masked; Expand All opens everything, turns read later
// too; Activity in an agent's menu and in the card dialog open it filtered; a process the agent left running ends from
// its details after a confirmation, and the agent's CLI has no End Process. Both themes. Fake Claude Code only (no
// sign-in, no tokens). HI-1677: nodes drawn don't move as work comes and goes (positions compared across updates), what
// ended stays dimmed; Pause holds the tree while updates count in the pill, which applies them; the time range, Hide
// finished, and the Agents and Cards filters (opened from an agent's menu or a card too). Dev build, throwaway profile,
// workspace and CLI homes; quiet.
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
const AGENTS = ['HB1', 'HB2', 'HR1'].map((n) => ({ id: n.toLowerCase(), name: n, provider: 'claude-code' }))
const SECRET = `sk-ant-api03-${'q'.repeat(40)}`
const GH = `ghp_${'z'.repeat(36)}`
// A prompt of several lines, longer than a node shows; and an input past round 1's 4,000-character cut.
const PROMPT = ['Fix the flaky test.', '', 'Steps:', '1. Reproduce it under load.', '2. Find the race.', `3. Fix it with a condition (key ${SECRET}).`, 'And then a long paragraph of plain words. '.repeat(10)].join('\n')
const LONG = `npm test -- ${'--flag '.repeat(800)}--end`
const line = (o) => JSON.stringify(o)
/** A finished session's transcript: `turns` prompts, each with a Bash and a Read call and a reply. */
function transcript(sid, turns, startMin) {
  const out = []
  let t = now - startMin * 60_000
  const at = () => new Date((t += 2000)).toISOString()
  for (let i = 0; i < turns; i++) {
    out.push(line({ type: 'user', sessionId: sid, cwd: alpha, timestamp: at(), message: { role: 'user', content: i === 0 ? `Turn 0: ${PROMPT}` : `Turn ${i}: carry on with the card` } }))
    for (const [k, tool] of [
      [0, { name: 'Bash', input: { command: i === 0 ? LONG : `npm test -- --token ${SECRET}`, description: 'Run the tests' } }],
      [1, { name: 'Read', input: { file_path: 'src/a.ts' } }]
    ]) {
      const id = `toolu_${sid.slice(0, 4)}_${i}_${k}`
      out.push(line({ type: 'assistant', sessionId: sid, requestId: `r${i}${k}`, timestamp: at(), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, ...tool }], usage: { input_tokens: 10, output_tokens: 5 } } }))
      out.push(line({ type: 'user', sessionId: sid, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] } }))
    }
    out.push(line({ type: 'assistant', sessionId: sid, requestId: `e${i}`, timestamp: at(), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `Done with turn ${i}.` }], usage: { input_tokens: 10, output_tokens: 5 } } }))
  }
  return out.join('\n') + '\n'
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
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)

    // --- Two cards; HB2's and HR1's sessions on them over the last hours, one of HR1's older than 24 hours.
    const one = await inv('tasks:create', { title: 'Card one', project: 'alpha', column: 'doing' })
    const two = await inv('tasks:create', { title: 'Card two', project: 'alpha', column: 'review' })
    const rec = (sid, agent, min, card, name) => ({ id: sid, agent: 'claude-code', agentId: agent.id, agentName: agent.name, name, cwd: alpha, createdAt: ago(min + 5), lastActiveAt: ago(min), archived: false, cards: card ? [{ number: card.number, title: card.title }] : [] })
    const S = { hb2: randomUUID(), hr1: randomUUID(), old: randomUUID(), loose: randomUUID() }
    fs.writeFileSync(path.join(transcripts, `${S.hb2}.jsonl`), transcript(S.hb2, 3, 80))
    fs.writeFileSync(path.join(transcripts, `${S.hr1}.jsonl`), transcript(S.hr1, 2, 50))
    fs.writeFileSync(path.join(transcripts, `${S.old}.jsonl`), transcript(S.old, 1, 30 * 60))
    fs.writeFileSync(path.join(transcripts, `${S.loose}.jsonl`), transcript(S.loose, 1, 15))
    // Last active 70, 40 and 10 minutes ago, and 30 hours (out of the data's 24).
    const file = sessionsOf(alpha)
    file.sessions.push(rec(S.hb2, AGENTS[1], 70, one, 'Building one'), rec(S.hr1, AGENTS[2], 40, two, 'Reviewing two'), rec(S.old, AGENTS[2], 30 * 60, two, 'An old review'), rec(S.loose, AGENTS[1], 10, null, 'A loose session'))
    putSessions(alpha, file)

    // --- HB1 running: a long turn with a background subagent.
    await page.getByText('alpha', { exact: true }).first().click()
    await inv('session:start', alpha, { agentId: 'hb1' })
    const liveOf = async () => (await inv('session:live')).find((x) => x.agentId === 'hb1') ?? null
    await lib.until(async () => ['ready', 'finished'].includes((await liveOf())?.status), HUNG_MS)
    // A command running for the turn, with a token on its command line.
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'hb1'), `shell: node -e "setTimeout(()=>{},20000)" ${GH} then subagent 50 then work 60`, { submitted: async () => (await liveOf())?.status === 'working' })

    // --- The tab: the cards with their agents and sessions, then the agents' loose sessions, HB1's running one among them.
    await page.locator('.tab', { hasText: 'Activity' }).click()
    const node = (kind, text) => page.locator(`.activity-node.act-${kind}`, text ? { hasText: text } : {})
    const titles = async () => page.locator('.activity-node').evaluateAll((els) => els.map((e) => `${e.className.match(/act-(\w+)/)[1]}:${e.querySelector('.activity-node-title')?.textContent ?? ''}`))
    await lib.until(async () => (await node('session', 'Reviewing two').count()) > 0 && (await node('process').count()) >= 2, HUNG_MS, 250)
    const shown = await titles()
    check('the cards, each with its agent and session, and the running agent with its session', ['card:', 'agent:HB2', 'session:Building one', 'agent:HR1', 'session:Reviewing two', 'agent:HB1'].every((t) => shown.some((s) => s.startsWith(t))), JSON.stringify(shown))
    check('a session older than 24 hours is left out', !shown.some((s) => s.includes('An old review')))
    check("HB2's session on no card is under HB2's own node", shown.includes('session:A loose session'))
    check('the running session shows its processes: its CLI, the two it left running and the command it runs', !!(await lib.until(async () => (await node('process', 'setTimeout').count()) > 0, HUNG_MS, 250)) && (await node('process').count()) >= 5, String(await node('process').count()))
    check("a process's command line shows with its token masked", !(await page.locator('.activity-tree').innerText()).includes(GH))
    await page.screenshot({ path: path.join(lib.WORK, 'activitytab-1-live-dark.png') })
    // HI-1677: where each node is drawn now; work then comes (the background subagent, after the command) and the command
    // ends (its process stays, dimmed): nothing drawn moves. The pointer is off the tree, which goes live (not held).
    await page.mouse.move(5, 5)
    const positions = async () => Object.fromEntries(await page.locator('.activity-node').evaluateAll((els) => els.map((e) => [e.dataset.key, `${e.style.left},${e.style.top}`])))
    const before = await positions()
    check("…and the agent's background subagent", !!(await lib.until(async () => (await node('task').count()) === 1, HUNG_MS, 250)))
    const ended = node('process', 'setTimeout')
    // Its cmd and its node: both stay, dimmed.
    const allGone = async () => (await ended.evaluateAll((els) => els.length > 0 && els.every((e) => e.classList.contains('act-gone')))) === true
    check('the command that ended stays where it was, dimmed', !!(await lib.until(allGone, HUNG_MS, 250)))
    const after = await positions()
    const moved = Object.keys(before).filter((k) => after[k] && after[k] !== before[k])
    check('nodes drawn before stay where they were as work comes and ends', Object.keys(before).length > 5 && moved.length === 0 && Object.keys(after).length > Object.keys(before).length, JSON.stringify({ moved, before: Object.keys(before).length, after: Object.keys(after).length }))

    // --- Pause: a new session while paused is counted in the pill, not drawn; the pill draws it, and it stays paused.
    const head = page.locator('.activity-head')
    await head.locator('.activity-live').click()
    await lib.until(async () => (await head.locator('.activity-live').getAttribute('aria-pressed')) === 'true', HUNG_MS)
    const added = randomUUID()
    fs.writeFileSync(path.join(transcripts, `${added}.jsonl`), transcript(added, 1, 2))
    const more = sessionsOf(alpha)
    more.sessions.push(rec(added, AGENTS[2], 1, null, 'A session while paused'))
    putSessions(alpha, more)
    const pill = head.locator('.activity-pill')
    check('paused, updates wait in the pill', !!(await lib.until(async () => /update/.test(await pill.innerText().catch(() => '')), HUNG_MS, 250)), await pill.innerText().catch(() => ''))
    check('…and the tree holds: the new session is not drawn', (await node('session', 'A session while paused').count()) === 0)
    await page.screenshot({ path: path.join(lib.WORK, 'activitytab-2-paused-dark.png') })
    await pill.click()
    // What the pill applies is what was read by then: the session list is read every few seconds, so until it has the new
    // session, the pill shows again for the next update and is clicked again, as a user would.
    check('the pill draws what came while paused', !!(await lib.until(async () => {
      if ((await node('session', 'A session while paused').count()) === 1) return true
      if (await pill.count()) await pill.click().catch(() => undefined)
      return false
    }, HUNG_MS, 250)))
    check('…and it stays paused, as paused by hand', (await head.locator('.activity-live').getAttribute('aria-pressed')) === 'true')
    await head.locator('.activity-live').click()
    await lib.until(async () => (await head.locator('.activity-live').getAttribute('aria-pressed')) === 'false', HUNG_MS)

    // --- The range (from the last refresh) and Hide finished.
    const range = (label) => head.locator('.activity-range button', { hasText: new RegExp(`^${label}$`) })
    await range('1 h').click()
    check('1 h: what was active in the last hour, and what runs', !!(await lib.until(async () => (await node('session', 'Building one').count()) === 0 && (await node('session', 'Reviewing two').count()) === 1 && (await node('session', 'A loose session').count()) === 1, HUNG_MS, 250)))
    await page.screenshot({ path: path.join(lib.WORK, 'activitytab-3-1h-dark.png') })
    await range('15 min').click()
    check('15 min: the last 15 minutes and what runs', !!(await lib.until(async () => (await node('session', 'Reviewing two').count()) === 0 && (await node('session', 'A loose session').count()) === 1, HUNG_MS, 250)))
    await range('Live').click()
    check('Live: only what runs', !!(await lib.until(async () => (await node('session', 'A loose session').count()) === 0 && (await node('agent', 'HB1').count()) === 1, HUNG_MS, 250)))
    await range('24 h').click()
    await head.locator('.activity-hide input').check()
    check('Hide finished: only what runs', !!(await lib.until(async () => (await node('session', 'Reviewing two').count()) === 0 && (await node('agent', 'HB1').count()) === 1, HUNG_MS, 250)))
    await head.locator('.activity-hide input').uncheck()
    await lib.until(async () => (await node('session', 'Reviewing two').count()) === 1, HUNG_MS, 250)

    // --- A finished session opens to its turns (read only then), a turn to its tool calls; a call's details.
    check("a finished session's turns aren't read until it opens", (await node('turn', 'Turn 0').count()) === 0)
    await node('session', 'Building one').locator('.activity-twisty').click()
    await lib.until(async () => (await node('turn', 'Turn').count()) >= 3, HUNG_MS)
    check('opened, a session shows its turns', (await node('turn', 'Turn').count()) === 3)
    // A prompt's details: the whole of it, as written (its line breaks), its key masked.
    await node('turn', 'Turn 0').first().click()
    const details = page.locator('.activity-details')
    const pre = details.locator('.activity-pre').first()
    await lib.until(async () => /Steps:/.test(await pre.innerText().catch(() => '')), HUNG_MS)
    const prompt = await pre.innerText()
    check("a prompt's details show it whole, its lines as written", prompt.includes('Steps:\n1. Reproduce it under load.') && prompt.includes('And then a long paragraph of plain words. '.repeat(10).trim()), prompt.slice(0, 200))
    check('…its key masked, as the log masks it', !prompt.includes('q'.repeat(40)) && prompt.includes('<redacted>'), prompt.slice(0, 300))
    await node('turn', 'Turn 0').first().locator('.activity-twisty').click()
    await lib.until(async () => (await node('tool', 'Bash').count()) > 0, HUNG_MS)
    await node('tool', 'Bash').first().click()
    await lib.until(async () => /--end/.test(await pre.innerText().catch(() => '')), HUNG_MS)
    const text = await pre.innerText()
    check("a tool call's details show its whole input, past round 1's 4,000-character cut", text.includes('--end') && text.length > 5000, String(text.length))
    // Playwright's click scrolled the tree to the call: back to its start, for a screenshot of the whole tree.
    await page.locator('.activity-tree').evaluate((el) => (el.scrollLeft = 0))
    await page.screenshot({ path: path.join(lib.WORK, 'activitytab-5-details-dark.png') })

    // --- Ending one of the agent's processes: its CLI has no End Process; one it left running ends after a confirmation.
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
    check('…and the agent still runs', !!(await liveOf()))
    // Not the agent's (another pid, or a start time that doesn't match): nothing is ended.
    check("main refuses a process that isn't the agent's", (await inv('activity:endProcess', alpha, 'hb1', process.pid, '1')) === 'notOwn')

    // --- Opened filtered: from an agent's menu (HR1's work only), and from the card dialog (that card's).
    await page.locator('.tab', { hasText: 'Session' }).first().click()
    await lib.agentMenu(page, 'HR1')
    await lib.menuEntry(page, 'Activity').click()
    const agentsPick = head.locator('.activity-pick').first()
    await lib.until(async () => /1 agent/.test(await agentsPick.innerText().catch(() => '')), HUNG_MS)
    await lib.until(async () => (await node('agent', 'HB2').count()) === 0, HUNG_MS)
    const hr1 = await titles()
    check("Activity in an agent's menu shows that agent's work", hr1.every((t) => !t.startsWith('agent:') || t === 'agent:HR1') && hr1.includes('session:Reviewing two'), JSON.stringify(hr1))
    await page.screenshot({ path: path.join(lib.WORK, 'activitytab-4-filtered-dark.png') })
    // Agents ▾: a second agent ticked, then All.
    await agentsPick.click()
    await lib.menuEntry(page, 'HB2').click()
    check('Agents ▾ takes several', !!(await lib.until(async () => /2 agents/.test(await agentsPick.innerText()) && (await node('agent', 'HB2').count()) > 0, HUNG_MS, 250)))
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')
    check('All clears it', !!(await lib.until(async () => /All agents/.test(await agentsPick.innerText()) && (await node('agent', 'HB1').count()) > 0, HUNG_MS, 250)))
    // Expand All: everything opens, a closed session's turns (read only once it opens) and their tool calls too.
    await node('session', 'Reviewing two').scrollIntoViewIfNeeded()
    check('Reviewing two starts closed', (await node('session', 'Reviewing two').getAttribute('aria-expanded')) === 'false')
    await page.locator('.activity-head').getByRole('button', { name: 'Expand All' }).click()
    // Its turns come after everything drawn (HI-1677): at the bottom of the tree, scrolled to.
    const tree = page.locator('.activity-tree')
    const reviewTools = async () => {
      await tree.evaluate((el) => (el.scrollTop = el.scrollHeight))
      return page.locator(`.activity-node.act-tool[data-key^="tool:${S.hr1}"]`).count()
    }
    check('Expand All opens a session whose turns come later, and their tool calls', !!(await lib.until(async () => (await reviewTools()) >= 4, HUNG_MS, 250)), String(await reviewTools()))
    await tree.evaluate((el) => (el.scrollTop = 0))
    await page.locator('.activity-head').getByRole('button', { name: 'Collapse All' }).click()
    check('Collapse All closes them all, down to the top-level nodes', !!(await lib.until(async () => (await node('turn').count()) === 0 && (await node('session').count()) === 0 && (await node('card').count()) > 0, HUNG_MS, 250)))
    await page.locator('.tab', { hasText: 'Tasks' }).first().click()
    await page.locator('.task-card', { hasText: 'Card one' }).first().click()
    await page.getByRole('button', { name: 'Activity' }).click()
    const cardsPick = head.locator('.activity-pick').nth(1)
    await lib.until(async () => /1 card/.test(await cardsPick.innerText().catch(() => '')) && (await node('card').count()) === 1, HUNG_MS, 250)
    const c1 = await titles()
    check("Activity in the card dialog shows that card's work", c1.filter((t) => t.startsWith('card:')).length === 1 && c1.some((t) => t.startsWith('card:') && t.includes('Card one')) && c1.includes('session:Building one') && !c1.includes('session:Reviewing two'), JSON.stringify(c1))

    // --- Light theme.
    await inv('settings:update', { appearance: { theme: 'light' } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', HUNG_MS)
    await cardsPick.click()
    await lib.menuEntry(page, 'All').click()
    await page.keyboard.press('Escape')
    await page.mouse.move(5, 5)
    await lib.until(async () => (await node('card').count()) === 2, HUNG_MS, 250)
    await page.screenshot({ path: path.join(lib.WORK, 'activitytab-6-light.png') })
    await inv('session:stop', alpha, 'hb1').catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
