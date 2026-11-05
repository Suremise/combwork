// A CLI's question by itself while idle (HI-1959), on a fake Claude Code agent (fake-claude/) with Claude Code 2.1.312's
// input box: after a turn it offers to teach auto mode about the environment, with no hook, as it did to HB4. The agent
// waits for the user with the question; a message left meanwhile isn't typed into the question, and no Enter answers it;
// once the user puts it off (Esc), the agent is idle and the message is delivered; the same for the offer drawn under its
// empty input box, as 2.1.314 draws it (HI-2191). Then a line Combwork typed that its CLI
// didn't take (both Enters dropped), taken off its input as that screen took HB4's wake: once its input is empty at its
// prompt, still so on Combwork's second look, the hold goes and the message is typed again, and read once. Dev build,
// throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
const QUESTION = 'Teach auto mode about your environment?'

const userData = path.join(lib.WORK, 'idlequestion-profile')
const ws = path.join(lib.WORK, 'idlequestion-ws')
const claudeHome = path.join(lib.WORK, 'idlequestion-claude-home')
const notifyLog = path.join(lib.WORK, 'idlequestion-notify.jsonl')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47704))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(notifyLog, { force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560) and for when Combwork typed what.
  lib.logFakeInput(claudeHome)
  // Claude Code 2.1.312's input box, which Combwork reads a lost line by.
  fs.writeFileSync(path.join(claudeHome, 'fake-input-box.txt'), '')
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off', HIVE_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const liveIn = async (folder, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === folder.toLowerCase() && s.agentId === id)
    const live = (id) => liveIn(alpha, id)
    const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 250)
    // Leaving an agent a message is the Assistant's (background.cjs): start it (the fake too) and use its token.
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => (await liveIn(home, 'assistant'))?.status === 'waiting')
    await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
    await until(async () => (await liveIn(home, 'assistant'))?.status === 'ready')
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const jsonl = (name) => {
      const f = path.join(claudeHome, name)
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    const hiveLog = () => {
      const f = path.join(userData, 'logs', 'combwork.log')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    }
    const notices = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    const read = async (id) => {
      const inbox = (await api('GET', '/v1/projects/alpha/agents/Builder/activity')).body?.inbox
      return !!inbox?.deliveries?.some((d) => d.id === id && (d.state === 'received' || d.state === 'acked'))
    }
    /** The doorbells Combwork typed into the agent (the input log's reads with "[CW] New in your inbox"), with when. */
    const doorbells = () => jsonl('fake-input.jsonl').filter((r) => /\[CW\] New in your inbox/.test(r.data))
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)

    await page.getByText('alpha', { exact: true }).first().click()
    const agent = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const key = lib.ptyKey(alpha, agent.id)
    await inv('session:start', alpha, { agentId: agent.id })
    check('the agent starts', !!(await until(() => idle(agent.id))))

    // ---- Its question by itself after a turn: the agent waits for the user with it.
    await lib.typeLine(inv, key, claudeHome, null, 'envsetup', { live: () => live(agent.id) })
    const asking = await until(async () => {
      const s = await live(agent.id)
      return s?.status === 'waiting' && s
    })
    check("after its turn, Claude Code's question shows it waiting for the user", !!asking && String(asking.statusMessage ?? '').includes(QUESTION), JSON.stringify(asking && { status: asking.status, message: asking.statusMessage }))
    check('…with the question in its pane', !!(await until(async () => (await page.locator('.pane-status', { hasText: QUESTION }).count()) >= 1)))
    check('…and the user is told it waits for them', !!(await until(async () => notices().some((n) => JSON.stringify(n).includes(QUESTION)))), JSON.stringify(notices()))
    await page.screenshot({ path: path.join(lib.WORK, 'idlequestion-asking.png') })

    // A message left meanwhile: never typed into the question, nor any Enter that would answer it.
    const first = await api('POST', '/v1/projects/alpha/agents/Builder/message', { text: 'The release notes are in the shared notes.' })
    check('a message can be left meanwhile', first.status === 200, JSON.stringify(first.body))
    const prompted = await api('POST', '/v1/projects/alpha/agents/Builder/prompt', { text: 'something else' })
    check('a prompt is refused while it waits for the user', prompted.status === 409, JSON.stringify(prompted.body))

    // The user puts it off (Esc): the agent is idle again, and only then is the message typed and read.
    const escAt = new Date().toISOString()
    await inv('pty:write', key, '\x1b')
    check('put off, the agent is idle again', !!(await until(() => idle(agent.id))), JSON.stringify(await live(agent.id)))
    check('…and the message is delivered and read', !!(await until(() => read(first.body?.id))))
    const rung = doorbells()
    check('nothing of Combwork\'s was typed while the question showed: its doorbell came after the user\'s Esc', rung.length > 0 && rung.every((r) => r.at >= escAt), JSON.stringify({ escAt, rung: rung.map((r) => r.at) }))
    check('Combwork never answered the question (no Enter on it)', JSON.stringify(jsonl('fake-envsetup.jsonl').map((r) => r.answer)) === '["later"]', JSON.stringify(jsonl('fake-envsetup.jsonl')))
    await until(() => idle(agent.id))

    // ---- The same offer as Claude Code 2.1.314 draws it (HI-2191): under its input box, the empty box kept above it.
    await lib.typeLine(inv, key, claudeHome, null, 'envsetupunder', { live: () => live(agent.id) })
    const under = await until(async () => {
      const s = await live(agent.id)
      return s?.status === 'waiting' && s
    })
    check("2.1.314's offer, under its empty input box: the agent waits for the user with it", !!under && String(under.statusMessage ?? '').includes(QUESTION), JSON.stringify(under && { status: under.status, message: under.statusMessage }))
    const third = await api('POST', '/v1/projects/alpha/agents/Builder/message', { text: 'The changelog is ready for review.' })
    const underEsc = new Date().toISOString()
    await inv('pty:write', key, '\x1b')
    check('…put off, it is idle again and the message is read', !!(await until(() => idle(agent.id))) && !!(await until(() => read(third.body?.id))), JSON.stringify(await live(agent.id)))
    check("…and nothing of Combwork's was typed into it while it showed", doorbells().filter((r) => r.data.includes(`(${third.body?.id})`)).every((r) => r.at >= underEsc), JSON.stringify(doorbells().slice(-3)))
    check('…never answered by Combwork', JSON.stringify(jsonl('fake-envsetup.jsonl').map((r) => r.answer)) === '["later","later"]', JSON.stringify(jsonl('fake-envsetup.jsonl')))
    await until(() => idle(agent.id))

    // ---- A line Combwork typed that its CLI didn't take, then taken off its input (as the question took HB4's wake).
    await app.evaluate((_, v) => void (process.env.HIVE_TEST_WAKE_TAKE_MS = v), '1500')
    fs.writeFileSync(path.join(claudeHome, 'fake-drop-enters-Builder.txt'), '2')
    const second = await api('POST', '/v1/projects/alpha/agents/Builder/message', { text: 'Darren pushed the tag: carry on with the release.' })
    const marked = await until(async () => (await live(agent.id))?.untakenLine)
    check('both Enters dropped: the line is held as not taken', second.status === 200 && !!marked, JSON.stringify(marked))
    const before = doorbells().length
    await app.evaluate((_, v) => void (process.env.HIVE_TEST_WAKE_TAKE_MS = v), String(HUNG_MS))
    fs.writeFileSync(path.join(claudeHome, 'fake-clear-line-Builder'), '')
    check('its input empty at its prompt, the hold goes', !!(await until(async () => !(await live(agent.id))?.untakenLine)))
    check('…the log says why', /gone from its input, nothing taken: what it rang for is offered again/.test(hiveLog()))
    check('…the message is typed again and read', !!(await until(() => read(second.body?.id))) && doorbells().length > before)
    // Its doorbell typed twice in all: the one the screen took, and once again; never a third time once it was read.
    const rangFor = doorbells().filter((r) => r.data.includes(`(${second.body?.id})`))
    check('…typed again exactly once', rangFor.length === 2, JSON.stringify(rangFor))
    check('the user is told of no lost line (it was a delivery, typed again)', !notices().some((n) => /didn't get a line Combwork typed/.test(JSON.stringify(n))))
  } catch (e) {
    check('the suite ran to the end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})()
