// The first usable connection is never chosen from partial detection, and a resume runs its conversation's own provider
// (#506). Claude Code (the fake) and Codex (the fake, on its test home: no account) are both turned on. 1. The
// Assistant starts a conversation: Claude Code (the first usable connection's). 2. Combwork restarts with Claude Code's
// detection held back (CW_TEST_SLOW_DETECT) so Codex answers first: the Assistant still offers its Claude Code
// conversation, and resuming it waits for the detection and runs Claude Code. 3. With the Assistant switched to Codex
// (HI-2108: its CLI is its own, as an agent's, no longer Settings → Assistant's), its Claude Code conversation still
// resumes in Claude Code (a change never re-points a conversation), asking for no restart. 4. Claude Code held beyond
// Combwork's wait (CW_TEST_DETECT_WAIT_MS): a new conversation of the Assistant, switched back to Claude Code, and an
// agent added with no connection are refused, not guessed.
// 5. A Claude Code agent switched to Codex resumes its Claude Code conversation in Claude Code; a new one runs Codex.
// 6. Claude Code held beyond the wait again: a launch of a known provider waits only for its own CLI, so the Assistant
// switched to Codex starts a conversation, and the agent resumes its Codex one. 7. The Claude Code conversation with
// its Combwork record gone (one started outside Combwork) still resumes in Claude Code, found by its transcript.
// Throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME; quiet. No real CLI runs.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf, putSessions } = require('./storeDocs.cjs')

const userData = path.join(lib.WORK, 'provdetect-profile')
const ws = path.join(lib.WORK, 'provdetect-ws')
const claudeHome = path.join(lib.WORK, 'provdetect-claude-home')
const codexHome = path.join(lib.WORK, 'provdetect-codex-home')
const HOLD_MS = 12000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(path.join(ws, 'alpha'))
  const env = { ...lib.fakeClaude(userData, claudeHome, [ws, path.join(ws, 'alpha')]), CODEX_HOME: codexHome }
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  /** Combwork started without lib.launch, whose appReady waits for every provider to be found: what these hold back. */
  const launchHeld = async (more) => {
    const a = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ CW_USER_DATA: userData, ...env, ...more }) })
    const p = await a.firstWindow()
    p.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(a, p, { width: 1400, height: 850 })
    await lib.until(() => p.evaluate(() => !!document.querySelector('.app .workbench')).catch(() => false), 30000)
    return { app: a, page: p, inv: (ch, ...x) => p.evaluate(([c, args]) => window.combwork.invoke(c, ...args), [ch, x]) }
  }
  /** The Assistant's CLI changed (HI-2108: it follows its connection; Codex has no account here, so its test home's, decision H), as part 5's agent's. */
  const assistantOn = (cli) => inv('agents:update', home, 'assistant', { provider: cli })

  // 1. The Assistant's first conversation, with both CLIs found.
  let { app, page, inv } = await lib.launch({ userData, env })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv, 'claude-code')
  await lib.waitForProvider(inv, 'codex')
  let home = (await inv('workspace:refresh')).assistant.path
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  const started = await inv('session:start', home, { agentId: 'assistant' })
  check('the Assistant’s conversation runs Claude Code (the first usable connection’s: first in order, installed)', started.provider === 'claude-code', started.provider)
  const ready = await lib.until(async () => ((await live())?.sessionId && ['ready', 'finished'].includes((await live()).status) ? await live() : null), 30000)
  const sid = ready?.sessionId
  check('…and is ready', !!sid, JSON.stringify(await live()))
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 20000)
  await app.close()

  // 2. Restarted with Claude Code's detection held back: Codex answers first.
  const t0 = Date.now()
  ;({ app, page, inv } = await launchHeld({ CW_TEST_SLOW_DETECT: `claude-code=${HOLD_MS}` }))
  await lib.openWorkspace(inv, page, ws)
  home = (await inv('workspace:refresh')).assistant.path
  const info = async () => inv('provider:info')
  const codexFirst = await lib.until(async () => {
    const i = await info()
    return i.codex && !i.codex.checking && i.codex.found && i['claude-code']?.checking && !i['claude-code'].found ? i : null
  }, HOLD_MS - 1000, 100)
  check('Codex is found while Combwork is still looking for Claude Code', !!codexFirst, JSON.stringify(await info()))
  // Settings → Providers' Default provider, which said "Automatic (checking…)" here, went with HI-2107 (decision A).
  console.log(`(Codex found ${Date.now() - t0} ms after the start; Claude Code is held ${HOLD_MS} ms)`)
  const offered = (await inv('workspace:refresh')).assistant.agents[0]?.resume?.id
  check('the Assistant still offers its Claude Code conversation to resume', offered === sid, String(offered))
  const stillChecking = (await info())['claude-code']?.checking
  const resumed = await inv('session:start', home, { agentId: 'assistant', resumeId: sid })
  check('resuming it while Claude Code is still being looked for waits, then runs Claude Code', stillChecking && resumed.provider === 'claude-code' && resumed.sessionId === sid, JSON.stringify({ stillChecking, provider: resumed.provider, sessionId: resumed.sessionId }))
  await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 30000)
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 20000)

  // 3. The Assistant switched to Codex: its Claude Code conversation still resumes in Claude Code.
  await lib.waitForProvider(inv, 'claude-code', 20000)
  await assistantOn('codex')
  const again = await inv('session:start', home, { agentId: 'assistant', resumeId: sid })
  check('with the Assistant switched to Codex, its Claude Code conversation resumes in Claude Code', again.provider === 'claude-code' && again.sessionId === sid, JSON.stringify({ provider: again.provider, sessionId: again.sessionId }))
  await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 30000)
  const restart = (await inv('workspace:refresh')).assistant.agents[0]?.restartNeeded
  check('…and asks for no restart: the connection is for its next new conversation', restart === false, String(restart))
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 20000)
  // Back on Claude Code for part 4, while both are found.
  await assistantOn('claude-code')
  await app.close()

  // 4. Claude Code's detection held beyond Combwork's wait: nothing is decided from a guess. A new conversation of the
  // Assistant switched back to Claude Code and an agent added with no connection are refused ("still looking"), nothing
  // starts and no agent is added; once Claude Code has answered, both work, with Claude Code.
  ;({ app, page, inv } = await launchHeld({ CW_TEST_SLOW_DETECT: 'claude-code=9000', CW_TEST_DETECT_WAIT_MS: '1500' }))
  await lib.openWorkspace(inv, page, ws)
  home = (await inv('workspace:refresh')).assistant.path
  const refused = await inv('session:start', home, { agentId: 'assistant' }).then(
    (st) => `started ${st.provider}`,
    (e) => String(e.message)
  )
  check('a new Assistant conversation is refused while Combwork is still looking, past its wait', /still looking for/.test(refused), refused)
  check('…and nothing starts', !(await live()))
  const alpha = path.join(ws, 'alpha')
  const agentsNow = async () => (await inv('workspace:get')).projects.find((p) => p.name === 'alpha')?.agents ?? []
  const before = (await agentsNow()).length
  const addRefused = await inv('agents:add', alpha, { location: 'project' }).then(
    (d) => `added ${d.provider}`,
    (e) => String(e.message)
  )
  check('an agent added with no connection is refused too, and none is added', /still looking for/.test(addRefused) && (await agentsNow()).length === before, `${addRefused}; ${before} → ${(await agentsNow()).length}`)
  await lib.waitForProvider(inv, 'claude-code', 20000)
  const fresh = await inv('session:start', home, { agentId: 'assistant' })
  check('once Claude Code has answered, a new conversation runs Claude Code', fresh.provider === 'claude-code', fresh.provider)
  await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 30000)
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 20000)
  const added = await inv('agents:add', alpha, { location: 'project' })
  check('…and a new agent is a Claude Code one', added.provider === 'claude-code', added.provider)

  // 5. An agent of its own provider switched since: its conversation still resumes in the provider that recorded it
  // (Darren's decision on #506); a new conversation runs its provider now.
  const agentLive = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === added.id)
  const agentReady = async () => ['ready', 'finished'].includes((await agentLive())?.status)
  const stopAgent = async () => {
    await inv('session:stop', alpha, added.id)
    await lib.until(async () => !(await agentLive()), 20000)
  }
  const first = await inv('session:start', alpha, { agentId: added.id })
  check('a Claude Code agent’s first conversation is ready', !!(await lib.until(agentReady, 30000)), JSON.stringify(await agentLive()))
  const asid = (await agentLive())?.sessionId
  // A prompt, so Claude Code has its transcript (part 7).
  await lib.sendPrompt(inv, lib.ptyKey(alpha, added.id), 'hello', { submitted: async () => ((await inv('session:usage', alpha, asid))?.requests ?? 0) > 0 })
  await stopAgent()
  await inv('agents:update', alpha, added.id, { provider: 'codex' })
  const back = await inv('session:start', alpha, { agentId: added.id, resumeId: asid })
  check('an agent switched from Claude Code to Codex resumes its Claude Code conversation in Claude Code', first.provider === 'claude-code' && back.provider === 'claude-code' && back.sessionId === asid, JSON.stringify({ first: first.provider, back: back.provider, asid, sessionId: back.sessionId }))
  await lib.until(agentReady, 30000)
  const agentInfo = async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha')?.agents.find((a) => a.id === added.id)
  check('…asking for no restart', (await agentInfo())?.restartNeeded === false, String((await agentInfo())?.restartNeeded))
  await stopAgent()
  const now = await inv('session:start', alpha, { agentId: added.id })
  check('…and a new conversation runs Codex, its provider now', now.provider === 'codex', now.provider)
  await lib.until(agentReady, 30000)
  // Codex has its conversation's id with the first prompt.
  await lib.sendPrompt(inv, lib.ptyKey(alpha, added.id), 'hello', { submitted: async () => !!(await agentLive())?.sessionId })
  const csid = (await agentLive())?.sessionId
  await stopAgent()
  await app.close()

  // 6. A launch of a known provider waits only for its own CLI, not for another still being looked for.
  // Its records are in the workspace's database (#1061), changed there while Combwork is closed.
  const saved = sessionsOf(alpha)
  check('the Claude Code conversation has a Combwork record, to remove', saved.sessions.some((s) => s.id === asid))
  saved.sessions = saved.sessions.filter((s) => s.id !== asid)
  putSessions(alpha, saved)
  ;({ app, page, inv } = await launchHeld({ CW_TEST_SLOW_DETECT: 'claude-code=9000', CW_TEST_DETECT_WAIT_MS: '1500' }))
  await lib.openWorkspace(inv, page, ws)
  home = (await inv('workspace:refresh')).assistant.path
  await lib.waitForProvider(inv, 'codex')
  await assistantOn('codex')
  const held = async () => (await inv('provider:info'))['claude-code']?.checking
  const codexNew = await inv('session:start', home, { agentId: 'assistant' }).then(
    (st) => st.provider,
    (e) => String(e.message)
  )
  check('with Claude Code still being looked for, past the wait, the Assistant switched to Codex starts a Codex conversation', codexNew === 'codex' && (await held()), `${codexNew}; Claude Code checking: ${await held()}`)
  await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 30000)
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 20000)
  const codexBack = await inv('session:start', alpha, { agentId: added.id, resumeId: csid }).then(
    (st) => `${st.provider} ${st.sessionId}`,
    (e) => String(e.message)
  )
  check('…and the agent resumes its Codex conversation', codexBack === `codex ${csid}` && (await held()), `${codexBack}; Claude Code checking: ${await held()}`)
  await lib.until(agentReady, 30000)
  await stopAgent()

  // 7. A conversation Combwork has no record of resumes in the provider whose CLI has its transcript.
  await lib.waitForProvider(inv, 'claude-code', 20000)
  const listed = (await inv('session:list', alpha)).find((s) => s.id === asid)
  check('the Claude Code conversation is listed as external, Claude Code’s', listed?.provider === 'claude-code' && listed?.source === 'external', JSON.stringify({ provider: listed?.provider, source: listed?.source }))
  const external = await inv('session:start', alpha, { agentId: added.id, resumeId: asid })
  check('…and the Codex agent resumes it in Claude Code', external.provider === 'claude-code' && external.sessionId === asid, JSON.stringify({ provider: external.provider, sessionId: external.sessionId }))
  await lib.until(agentReady, 30000)
  await stopAgent()

  await app.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
