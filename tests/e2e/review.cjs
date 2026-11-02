// Reviewing a card through an agent's own hive tools: the card stays in Review with the agent that did the work, the
// board shows "Reviewing: <reviewer>" and the reviewer's strip tab shows the card (with an eye); a second reviewer is
// refused; the reviewer's session ending stops the review; a verdict ends it (the card staying in Review, or going to
// Done with it); the reviewer's session records the card as reviewed. Also what the agents' hive tools say about
// reviewing, from the MCP server as an agent's mcp.json starts it. The agents run the fake Claude Code (fake-claude/),
// whose "boardreview N ACTION [COLUMN]" calls the hive tools' API with its own token. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'review-profile')
const ws = path.join(lib.WORK, 'review-ws')
const claudeHome = path.join(lib.WORK, 'review-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Starts the hive MCP server as an agent's mcp.json says, and returns its answers to `msgs`. */
function mcp(config, msgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(config.command, config.args ?? [], { env: lib.childEnv(config.env) })
    let out = ''
    const t = setTimeout(() => {
      p.kill()
      reject(new Error(`no answer: ${out.slice(0, 200)}`))
    }, 15000)
    p.stdout.on('data', (d) => {
      out += d
      const lines = out.trim().split('\n').filter(Boolean)
      if (lines.length >= msgs.length) {
        clearTimeout(t)
        p.kill()
        resolve(lines.map((l) => JSON.parse(l)))
      }
    })
    for (const m of msgs) p.stdin.write(JSON.stringify(m) + '\n')
  })
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47900), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const calls = () => {
    const f = path.join(claudeHome, 'fake-calls.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  /** Starts an agent (if it isn't running) and has it say `text`, waiting for its turn to end. */
  const say = async (id, text) => {
    if (!(await live(id))) {
      await inv('session:start', alpha, { agentId: id })
      await until(async () => (await live(id))?.status === 'ready', HUNG_MS)
    }
    await until(async () => ['ready', 'finished'].includes((await live(id))?.status), HUNG_MS)
    const before = calls().length
    // Typed again if a wake of Hive's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
    await until(async () => calls().length > before && (await live(id))?.status === 'finished', HUNG_MS)
    return calls().at(-1)
  }
  const stop = async (id) => {
    await inv('session:stop', alpha, id)
    return !!(await until(async () => !(await live(id)), HUNG_MS))
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  const third = await lib.addAgent(inv, alpha, { name: 'Third' })
  const c = await inv('tasks:create', { title: 'Lean replies', project: 'alpha', agent: coder.id, column: 'review' })
  const n = c.number

  // --- The reviewer starts its review with its own hive tools.
  const started = await say(reviewer.id, `boardreview ${n} start`)
  check('the hive tools take review start', started?.status === 200 && started.body?.changes?.includes('Started reviewing'), JSON.stringify(started))
  const r1 = await card(n)
  check('the card stays in Review with the agent that did the work', r1.column === 'review' && r1.agent === coder.id, JSON.stringify({ column: r1.column, agent: r1.agent }))
  check('and is marked as reviewed by the reviewer', r1.review?.agent === reviewer.id && r1.review?.agentName === 'Reviewer', JSON.stringify(r1.review))

  // On the board, and on the reviewer's strip tab.
  await page.keyboard.press('Control+Shift+J')
  const tile = page.locator(`.task-card[data-task="${n}"]`)
  check('the board shows who is reviewing it', !!(await until(async () => /Reviewing: Reviewer/.test(await tile.locator('.task-review').innerText().catch(() => '')), 5000)))
  check('not as stalled', !(await tile.locator('.task-review').getAttribute('class')).includes('stalled'))
  await page.screenshot({ path: path.join(lib.WORK, 'review-1-board.png') })
  // Back to the project.
  await page.keyboard.press('Control+Shift+E')
  await page.getByText('alpha', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Session' }).first().click()
  // On each agent's pane header (#975: its strip tab had it).
  const chip = (name) => lib.paneHeader(page, name).locator('.card-chip')
  check("the reviewer's pane header shows the card, with an eye", !!(await until(async () => (await chip('Reviewer').getAttribute('data-review').catch(() => null)) === 'true', 5000)) && (await chip('Reviewer').innerText()).includes(await lib.cardLabel(inv, n)))
  check("the coder's doesn't (it isn't working on it)", (await chip('Coder').count()) === 0)

  // --- A second reviewer is refused, naming the first.
  const refused = await say(third.id, `boardreview ${n} start`)
  check('a second reviewer is refused, naming the reviewer', refused?.status >= 400 && /Reviewer is already reviewing/.test(JSON.stringify(refused.body)), JSON.stringify(refused))
  check('and nothing changes', (await card(n)).review?.agent === reviewer.id)

  // --- The reviewer's session ending stops the review.
  check('the reviewer stops', await stop(reviewer.id))
  const r2 = await until(async () => {
    const x = await card(n)
    return !x.review && x
  }, 5000)
  check("its session ending stops the review, and says so in the card's history", !!r2 && r2.history.some((h) => h.what === 'Review by Reviewer stopped: its session ended'), JSON.stringify(r2?.history?.slice(-2)))
  check('the card is still in Review with its agent', r2 && r2.column === 'review' && r2.agent === coder.id)

  // --- A review with a verdict: failed sends it back to Doing with its agent (HI-1946); passed with Done moves it there.
  await say(reviewer.id, `boardreview ${n} start`)
  const verdict = await say(reviewer.id, `boardreview ${n} failed`)
  const r3 = await card(n)
  check('a failed verdict ends the review, the card back in Doing with its agent', verdict?.status === 200 && !r3.review && r3.column === 'doing' && r3.agent === coder.id && JSON.stringify(r3.history.slice(-2).map((h) => h.what)) === '["Review failed","Moved to Doing"]', JSON.stringify(r3.history.slice(-2)))
  // Its fixes done, the user moves it to Review again (its next round), to be reviewed again.
  await inv('tasks:update', n, { column: 'review' })
  await say(reviewer.id, `boardreview ${n} start`)
  const passed = await say(reviewer.id, `boardreview ${n} passed done`)
  const r4 = await card(n)
  check('passed with Done (as the user asked) moves it to Done with its agent', passed?.status === 200 && r4.column === 'done' && r4.agent === coder.id && !r4.review, JSON.stringify({ column: r4.column, agent: r4.agent, review: r4.review }))
  check('the verdict is a comment', r4.comments.at(-1)?.text === 'Fake review: passed.')

  // --- The reviewer's session recorded the card as reviewed.
  const sid = (await live(reviewer.id)).sessionId
  const rec = sessionsOf(alpha).sessions.find((s) => s.id === sid)
  check("the reviewer's session records the card as reviewed", !!rec?.cards?.some((x) => x.number === n && x.review === true), JSON.stringify(rec?.cards))

  // --- What the agents' hive tools say, from the MCP server as the reviewer's mcp.json starts it.
  // In the launch's private folder in Hive's user data, not the project (#345).
  const mcpFile = path.join(lib.launchDir(userData, (await live(reviewer.id)).runId), 'mcp.json')
  const server = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.hive
  const [init, list] = await mcp(server, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  ]).then((r) => [r.find((x) => x.id === 1), r.find((x) => x.id === 2)])
  const instructions = init?.result?.instructions ?? ''
  check("the agents' instructions tell reviewing from working on a card, and name the skill", /asked to review or check one, use review-agent-work/.test(instructions) && /\bhive_start_review then hive_verdict\b/.test(instructions), instructions.slice(0, 400))
  const update = list?.result?.tools?.find((t) => t.name === 'hive_update_task')
  check('hive_update_task describes reviewing, and takes review', /reviewing isn't working on it/.test(update?.inputSchema?.properties?.review?.description ?? '') && JSON.stringify(update?.inputSchema?.properties?.review?.enum) === '["start","passed","failed"]', JSON.stringify(update?.inputSchema?.properties?.review))
  // The reviewer's launch carries the review skill (its own copy, in its launch plugin).
  const skillFile = path.join(alpha, '.hive', `launch-${reviewer.id}`, 'plugin', 'skills', 'review-agent-work', 'SKILL.md')
  // HI-2011: the review mechanics are in its reference file beside SKILL.md, copied with it.
  const otherTargets = path.join(path.dirname(skillFile), 'other-targets.md')
  check("the reviewer's launch has the review-agent-work skill", fs.existsSync(skillFile) && fs.existsSync(otherTargets) && /review: "start"/.test(fs.readFileSync(otherTargets, 'utf8')))
  check('…but not the Assistant\'s coordinate-agents', !fs.existsSync(path.join(alpha, '.hive', `launch-${reviewer.id}`, 'plugin', 'skills', 'coordinate-agents')))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
