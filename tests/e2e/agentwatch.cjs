// Agent watches (#416): hive_wait_for_agents with wake, on fake Claude Code agents (fake-claude/). A watcher asks to be
// told when another agent is done and ends its turn at once (watching, "Waiting for Worker to finish"); Hive types one
// line into it when the agent finishes its turn (with its reply), starts waiting for the user, or stops; exactly once
// each. Also: an agent not working is the answer at once; nothing is typed while the watcher works or the user types
// there; limitMinutes ends a watch with a "still working" line; cancel ends one. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
// A fake's hive tool call took 20 s under a loaded machine (#667).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'agentwatch-profile')
const ws = path.join(lib.WORK, 'agentwatch-ws')
const claudeHome = path.join(lib.WORK, 'agentwatch-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47863))
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
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  // A short typing pause, so the test of "not while the user types" doesn't take long: the test keeps typing for as long
  // as it checks that no line comes (#667), so a loaded machine's slow steps don't outlast the pause.
  cfg.settings.assistant = { ...cfg.settings.assistant, typingPause: 4, enterEndsPause: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const wakes = (agent) => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => !agent || w.agent === agent).map((w) => w.text)
  }
  const start = async (id) => {
    await inv('session:start', alpha, { agentId: id })
    return until(async () => (await live(id))?.status === 'ready', HUNG_MS)
  }
  /** Types a prompt into an agent (as the user does), Enter included. */
  const say = async (id, text) => {
    // Typed again if a wake of Hive's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
  }
  const watchOn = (name, extra = {}) => `hive hive_wait_for_agents ${JSON.stringify({ agents: [{ project: 'alpha', agent: name }], wake: true, ...extra })}`
  /** Lets a fake's turn go on (holduntil NAME) or ask (askwhen NAME): the file it waits for, in its home. */
  const go = (name) => fs.writeFileSync(path.join(claudeHome, name), '')
  /**
   * The watcher watches the worker (#667): each step's worker turn is held (holduntil) so it can't end, or ask, before
   * the watch is set up, however slowly a loaded machine gets there.
   */
  const watchWorker = async (what) => {
    await say(watcher.id, watchOn('Worker'))
    check(`${what}: the watcher watches the worker`, !!(await until(async () => (await live(watcher.id))?.status === 'watching', HUNG_MS)), JSON.stringify({ watcher: (await live(watcher.id))?.status, worker: (await live(worker.id))?.status, reply: await lastWaitReply(watcher.id) }))
  }
  /** Between steps: both agents' turns over, so nothing of a step's is still to come in the next (#667). */
  const settle = async (what) => check(`${what}: both agents' turns are over`, !!(await until(async () => (await idle(watcher.id)) && (await idle(worker.id)) && !(await live(watcher.id))?.watch, HUNG_MS)), JSON.stringify({ watcher: await live(watcher.id).then((s) => [s?.status, s?.watch?.label]), worker: (await live(worker.id))?.status }))
  /** The result of the agent's latest hive_wait_for_agents call, from its transcript. */
  const waitReplies = async (id) => {
    const s = await live(id)
    const items = s?.sessionId ? ((await inv('transcript:read', alpha, s.sessionId).catch(() => null))?.items ?? []) : []
    return items.filter((x) => x.kind === 'tool' && x.tool.name === 'hive · hive_wait_for_agents').map((x) => x.tool.result ?? null)
  }
  const lastWaitReply = async (id) => (await waitReplies(id)).at(-1) ?? null
  /** Whether an agent's turn has ended and it isn't watching. */
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)

  await page.getByText('alpha', { exact: true }).first().click()
  const watcher = await lib.addAgent(inv, alpha, { name: 'Watcher' })
  const worker = await lib.addAgent(inv, alpha, { name: 'Worker' })
  const limiter = await lib.addAgent(inv, alpha, { name: 'Limiter' })
  const slow = await lib.addAgent(inv, alpha, { name: 'Slow' })
  for (const a of [watcher, worker, limiter, slow]) await start(a.id)

  // --- The limit (checked at the end): Limiter watches Slow, which works until the suite stops it, longer than the
  // watch's one minute (#667: 240 s, which a loaded machine's run outlasted, now longer than any run).
  await say(slow.id, 'work 900')
  await until(async () => (await live(slow.id))?.status === 'working', HUNG_MS)
  await say(limiter.id, watchOn('Slow', { limitMinutes: 1 }))
  const limitFrom = Date.now()
  check('a watch on a working agent: the watcher ends its turn at once, watching', !!(await until(async () => (await live(limiter.id))?.status === 'watching', HUNG_MS)), (await live(limiter.id))?.status)

  // --- An agent not working is the answer at once: no watch.
  await say(watcher.id, watchOn('Worker'))
  await until(async () => (await lastWaitReply(watcher.id)) !== null && (await idle(watcher.id)), HUNG_MS)
  const already = await lastWaitReply(watcher.id)
  check('watching an idle agent answers at once: already, and no watch', (already ?? '').startsWith('Already: Worker (alpha) is idle') && !(await live(watcher.id))?.watch, already)
  // …and that answer ends a watch it had, saying so, the busy agent asked about again included (#1530, HR2's rounds 1-2).
  await say(watcher.id, watchOn('Slow'))
  await until(async () => (await live(watcher.id))?.status === 'watching', HUNG_MS)
  await say(watcher.id, `hive hive_wait_for_agents ${JSON.stringify({ agents: [{ project: 'alpha', agent: 'Slow' }, { project: 'alpha', agent: 'Worker' }], wake: true })}`)
  await until(async () => ((await lastWaitReply(watcher.id)) ?? '').startsWith('Already: ') && (await idle(watcher.id)), HUNG_MS)
  const ended = await lastWaitReply(watcher.id)
  check("…and ends a watch it had, saying so: every agent it followed", (ended ?? '').startsWith('Already: Worker (alpha) is idle') && (ended ?? '').endsWith(" Your watch on Slow (alpha) has ended: watch again, passing every agent you're following.") && !(await live(watcher.id))?.watch, ended)

  // --- Finishing its turn: one line, with its reply. Its turn is held until the watcher watches (not a fixed time,
  // which a loaded machine outran: #667).
  await say(worker.id, 'work 1 holduntil agentwatch-first')
  await until(async () => (await live(worker.id))?.status === 'working', HUNG_MS)
  const t0 = Date.now()
  await say(watcher.id, watchOn('Worker'))
  const watching = await until(async () => (await live(watcher.id))?.status === 'watching', HUNG_MS)
  const st = await live(watcher.id)
  check('the watcher is watching while the worker still works, with what for', !!watching && st?.watch?.label === 'Waiting for Worker to finish' && (await live(worker.id))?.status === 'working', JSON.stringify({ watch: st?.watch, worker: (await live(worker.id))?.status, ms: Date.now() - t0 }))
  const reply = await lastWaitReply(watcher.id)
  check('the tool replied at once, saying to end the turn', (reply ?? '').startsWith('Waiting for Worker to finish. End your turn now'), reply)
  check('its header says so, with Cancel', !!(await until(async () => (await page.locator('.pane-status.watching', { hasText: 'Waiting for Worker to finish' }).count()) >= 1, HUNG_MS)))
  const status = (await api('GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Watcher')
  check('the Agent API reports the watch, with the agent watched', status?.status === 'watching' && status?.statusMessage === 'Waiting for Worker to finish' && status?.watching?.agents?.[0] === 'Worker', JSON.stringify(status))
  await page.screenshot({ path: path.join(lib.WORK, 'agentwatch-watching.png') })
  go('agentwatch-first')
  await until(async () => wakes('Watcher').length >= 1, HUNG_MS)
  await lib.sleep(2000) // A fixed wait on purpose: this checks that a second line does NOT come.
  const w1 = wakes('Watcher')
  check('woken exactly once when the worker finished, with its reply', w1.length === 1 && w1[0].startsWith('[Hive] Worker (alpha) finished: "Done: work 1 holduntil agentwatch-first"') && w1[0].includes('Your agent watch has ended'), JSON.stringify(w1))
  await until(() => idle(watcher.id), HUNG_MS)
  check('…and the watch has ended', !(await live(watcher.id))?.watch)
  await settle('finishing')

  // --- Waiting for the user: a permission prompt during its turn, once the watcher watches (#667: a set time into the
  // turn, which a loaded machine's watch came after: "Already: … waiting for the user", and no wake).
  await say(worker.id, 'askwhen agentwatch-permission holduntil agentwatch-answered')
  await until(async () => (await live(worker.id))?.status === 'working', HUNG_MS)
  await watchWorker('waiting')
  go('agentwatch-permission')
  await until(async () => wakes('Watcher').length >= 2, HUNG_MS)
  const w2 = wakes('Watcher')
  check('woken once when the worker waits for the user', w2.length === 2 && w2[1].startsWith('[Hive] Worker (alpha) is waiting for the user'), JSON.stringify(w2.slice(1)))
  // Its turn then ends with no watch on it: the step is over only once it has (#667: a late "finished" line, typed in
  // the next step).
  go('agentwatch-answered')
  await settle('waiting')
  check('…and no line when its turn then ended', wakes('Watcher').length === 2, JSON.stringify(wakes('Watcher').slice(2)))
  // That end is still news to the watcher (its wake told only the wait): a watch now would fire at once with it, "working
  // again now", typed into the next step if the watcher took a while to be given its next prompt (HI-2383). Watching
  // again tells it at once, so the next step's watch starts after it.
  const asked = (await waitReplies(watcher.id)).length
  await say(watcher.id, watchOn('Worker'))
  await until(async () => (await waitReplies(watcher.id)).length > asked && (await lastWaitReply(watcher.id)) !== null && (await idle(watcher.id)), HUNG_MS)
  const caught = await lastWaitReply(watcher.id)
  check('…and watching again, told it at once: idle, with its reply', (caught ?? '').startsWith('Already: Worker (alpha) is idle: "Done: askwhen agentwatch-permission') && !(await live(watcher.id))?.watch, caught)

  // --- Not while the watcher works: the line waits for its turn to end. Both turns are held until the test lets them
  // end (#667), so the worker finishes while the watcher works, however slow the machine.
  await say(worker.id, 'holduntil agentwatch-busy')
  await until(async () => (await live(worker.id))?.status === 'working', HUNG_MS)
  await watchWorker('busy')
  await say(watcher.id, 'holduntil agentwatch-busy-watcher')
  await until(async () => (await live(watcher.id))?.status === 'working', HUNG_MS)
  go('agentwatch-busy')
  await until(() => idle(worker.id), HUNG_MS)
  await lib.sleep(2500) // A fixed wait on purpose: this checks that no line comes while the watcher works.
  check('no line while the watcher works', wakes('Watcher').length === 2 && (await live(watcher.id))?.status === 'working', JSON.stringify({ lines: wakes('Watcher').slice(2), watcher: (await live(watcher.id))?.status }))
  go('agentwatch-busy-watcher')
  check('…then one, once its turn has ended', !!(await until(async () => wakes('Watcher').length === 3, HUNG_MS)) && wakes('Watcher')[2].startsWith('[Hive] Worker (alpha) finished'), JSON.stringify(wakes('Watcher').slice(2)))
  await settle('busy')

  // --- Not while the user types there (no Enter): the line waits out the typing pause. The user keeps typing until
  // the check is done (#667: a pause that ran out while a loaded machine finished the worker's turn).
  await say(worker.id, 'holduntil agentwatch-typing')
  await until(async () => (await live(worker.id))?.status === 'working', HUNG_MS)
  await watchWorker('typing')
  const key = lib.ptyKey(alpha, watcher.id)
  await inv('pty:write', key, 'half a thought')
  const typing = { on: true }
  const keepTyping = (async () => {
    // A key every half second, well inside the 4 s pause: typing, not a wait for a check.
    while (typing.on) {
      await lib.sleep(500)
      if (typing.on) await inv('pty:write', key, '.')
    }
  })()
  go('agentwatch-typing')
  await until(() => idle(worker.id), HUNG_MS)
  await lib.sleep(1500) // A fixed wait on purpose: this checks that no line comes while the user types.
  check('no line while the user is typing there', wakes('Watcher').length === 3, JSON.stringify(wakes('Watcher').slice(3)))
  typing.on = false
  await keepTyping
  check('…and one once the typing pause has passed', !!(await until(async () => wakes('Watcher').length === 4, HUNG_MS)), JSON.stringify(wakes('Watcher').slice(3)))
  await settle('typing')

  // --- Stopping: one line.
  await say(worker.id, 'holduntil agentwatch-never')
  await until(async () => (await live(worker.id))?.status === 'working', HUNG_MS)
  await watchWorker('stopping')
  await inv('session:stop', alpha, worker.id)
  await until(async () => wakes('Watcher').length >= 5, HUNG_MS)
  const w5 = wakes('Watcher')
  check('woken once when the worker stops', w5.length === 5 && w5[4].startsWith('[Hive] Worker (alpha) stopped'), JSON.stringify(w5.slice(4)))
  await until(() => idle(watcher.id), HUNG_MS)

  // --- Cancel: the watcher ends its own watch, and nothing is typed when the agent finishes. The worker's turn is held
  // until the cancel is in (not a fixed time, which a loaded machine outran: #667), then ends.
  await start(worker.id)
  await say(worker.id, 'holduntil agentwatch-cancelled')
  await until(async () => (await live(worker.id))?.status === 'working', HUNG_MS)
  await watchWorker('cancel')
  await say(watcher.id, 'hive hive_wait_for_agents {"cancel":true}')
  await until(async () => (await lastWaitReply(watcher.id)) === 'Cancelled your agent watch.' && (await idle(watcher.id)), HUNG_MS)
  check('cancel ends the agent watch', (await lastWaitReply(watcher.id)) === 'Cancelled your agent watch.' && !(await live(watcher.id))?.watch, await lastWaitReply(watcher.id))
  go('agentwatch-cancelled')
  await until(() => idle(worker.id), HUNG_MS)
  await lib.sleep(3000) // A fixed wait on purpose: this checks that no line comes after a cancel.
  check('…and no line came when the worker finished', wakes('Watcher').length === 5, JSON.stringify(wakes('Watcher').slice(5)))

  // --- The limit: a minute with Slow still working ends Limiter's watch with a "still working" line.
  const left = 60000 - (Date.now() - limitFrom)
  if (left > 0) await lib.sleep(left)
  await until(async () => wakes('Limiter').length >= 1, HUNG_MS)
  const lw = wakes('Limiter')
  check('limitMinutes passing with the agent still working: one "still working" line', lw.length === 1 && lw[0].startsWith('[Hive] Slow is still working after 1 min: your agent watch has ended'), JSON.stringify(lw))
  check('…while Slow still works', ['working'].includes((await live(slow.id))?.status), (await live(slow.id))?.status)

  await inv('session:stop', alpha, slow.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
