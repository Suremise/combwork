// A CLI that runs from a description alone (HI-3196), through Combwork with the fake datacli (fake-datacli/): no provider
// of its own, only a JSON file in the profile's clis folder. Combwork finds it by the description's paths and reads its
// version by its pattern; the Agent API lists what it lacks; an agent on it starts with its first prompt typed once its
// screen is ready, under Combwork's session id, with the description's variables; its status follows its screen and its
// OSC 7501 (working, then finished); its question waits for the user and a prompt from the API is refused meanwhile. A
// session that took a prompt resumes by its id; one stopped before any prompt, or whose only answer was to a question
// before its prompt, is never resumed (Resume names the agent's earlier conversation); a prompt the user types counts.
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'datacli-profile')
const ws = path.join(lib.WORK, 'datacli-ws')
const proj = path.join(ws, 'demo')
const fakeLog = path.join(lib.WORK, 'datacli-fake.jsonl')
const fakeStore = path.join(lib.WORK, 'datacli-store.json')
const hold = path.join(lib.WORK, 'datacli-hold')
const trust = path.join(lib.WORK, 'datacli-trust')
const holdLaunch = path.join(lib.WORK, 'datacli-hold-launch')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const launches = () => lines().filter((e) => e.kind === 'launch')
const arg = (e, name) => (e && e.args.includes(name) ? e.args[e.args.indexOf(name) + 1] : undefined)

/** The description, as a user writes one (docs/USER_GUIDE.md, Your own CLIs). */
const description = {
  id: 'fake-data',
  name: 'Fake Data CLI',
  binary: { names: ['datacli'], paths: [path.join(__dirname, 'fake-datacli', 'datacli.cmd')], versionArgs: ['--version'], versionPattern: 'datacli (\\d+\\.\\d+\\.\\d+)' },
  launch: { prompt: 'typed', modes: [{ value: 'yolo', label: 'Yolo', args: ['--yolo'] }], env: { FAKE_DATACLI_MARK: 'from-description' } },
  session: { new: ['--session-id', '{id}'], resume: ['--resume', '{id}'] },
  status: { ready: '^> ', working: 'Working…', asks: '(Allow|Trust this folder)\\? \\(y/n\\)', osc7501: true, exit: '/exit' }
}
/** The same CLI described with no way to resume a session. */
const noSession = { ...description, id: 'fake-nosession', name: 'Fake No-Session CLI', launch: { prompt: 'typed' }, session: undefined }
/** One the suite removes while a launch of it prepares: that launch keeps it (its arguments say which). */
const held = { ...noSession, id: 'fake-held', name: 'Fake Held CLI', launch: { prompt: 'typed', args: ['--from', 'first'] } }

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const f of [fakeLog, fakeStore, hold, trust, holdLaunch, `${holdLaunch}.held`]) fs.rmSync(f, { force: true })
  fs.mkdirSync(path.join(userData, 'clis'), { recursive: true })
  fs.writeFileSync(path.join(userData, 'clis', 'fake-data.json'), JSON.stringify(description, null, 2))
  fs.writeFileSync(path.join(userData, 'clis', 'fake-nosession.json'), JSON.stringify(noSession, null, 2))
  fs.writeFileSync(path.join(userData, 'clis', 'fake-held.json'), JSON.stringify(held, null, 2))
  lib.gitProject(proj)
  lib.enableProviders(userData, ['claude-code', 'fake-data', 'fake-nosession', 'fake-held'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // The user's typing pause outlasts an Enter here (enterEndsPause off), one second long: a first prompt it holds is tried
  // again when it ends, though nothing more is drawn.
  cfg.settings.assistant = { ...cfg.settings.assistant, enterEndsPause: false, typingPause: 1 }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let app, page, inv, api
  /** Combwork started on the profile, its workspace open, and the Assistant running on the fake Claude Code for its token. */
  const boot = async () => {
    ;({ app, page, inv } = await lib.launch({ userData, env: { FAKE_DATACLI_LOG: fakeLog, FAKE_DATACLI_STORE: fakeStore, FAKE_DATACLI_HOLD: hold, FAKE_DATACLI_TRUST: trust, CW_TEST_HOLD_LAUNCH: holdLaunch, CW_API_PORT: lib.port(47899) }, viewport: { width: 1400, height: 900 } }))
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    // The Assistant's token (only it starts agents and gives them tasks through the Agent API): its session on the fake Claude Code.
    const home = (await inv('workspace:refresh')).assistant.path
    const assistantLive = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.status !== 'stopped')
    await inv('session:start', home, { agentId: 'assistant' })
    await lib.until(async () => (['waiting', 'ready'].includes((await assistantLive())?.status) ? true : null), HUNG_MS, 200)
    if ((await assistantLive())?.status === 'waiting') await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
    await lib.until(async () => ((await assistantLive())?.status === 'ready' ? true : null), HUNG_MS, 200)
    // Never on a CLI without Combwork's tools, though a described CLI's account may come first (HI-3196).
    check('the Assistant runs on a CLI with its tools, not a described one', (await assistantLive())?.provider === 'claude-code', (await assistantLive())?.provider)
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`), 'utf8')).token
    api = (method, url, body) =>
      fetch(`http://127.0.0.1:${lib.port(47899)}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  }
  await boot()
  try {
    const info = await lib.waitForProvider(inv, 'fake-data')
    check('the described CLI is found by its paths, its version by its pattern', String(info.path ?? '').toLowerCase().endsWith('datacli.cmd') && info.version === '1.2.3', JSON.stringify({ path: info.path, version: info.version }))
    const snap = await inv('clis:snapshot')
    check('the clis snapshot has it, with no problems', snap.clis.some((c) => c.id === 'fake-data') && !snap.problems.length, JSON.stringify(snap.problems))

    const providers = await api('GET', '/v1/providers')
    const listed = providers.body?.find?.((p) => p.id === 'fake-data')
    check('GET /v1/providers lists it with what it lacks', !!listed && [/tools/, /hooks/, /transcript/, /cost/].every((g) => listed.gaps?.some((t) => g.test(t))) && !listed.gaps.some((t) => /resum/.test(t)), JSON.stringify(listed?.gaps))
    check('…and a full provider with no gaps', providers.body.find((p) => p.id === 'claude-code')?.gaps === undefined)
    check('…and one described without a session lacks resume too', providers.body.find((p) => p.id === 'fake-nosession')?.gaps?.some((t) => /resum/.test(t)), JSON.stringify(providers.body.find((p) => p.id === 'fake-nosession')?.gaps))

    // --- Settings has each CLI's page and its advanced values (registered at start), and follows a Reload: a CLI added,
    // changed (its name, how it is found) and removed.
    await page.keyboard.press('Control+,')
    const navRow = (text) => page.locator('.settings-nav .row', { hasText: text })
    await lib.until(async () => ((await navRow('Fake Data CLI').count()) === 1 ? true : null), HUNG_MS)
    await navRow('Fake Data CLI').click()
    check("Settings has a described CLI's page, with its CLI path", !!(await lib.until(async () => ((await page.locator('[data-setting="fake-data.executablePath"]').count()) === 1 ? true : null), HUNG_MS)))
    await navRow('Advanced').click()
    const advTab = (id) => page.locator(`.advanced-list .advanced-tabs [role="tab"][data-tab="${id}"]`)
    check('…and Settings → Advanced has its tab', !!(await lib.until(async () => ((await advTab('fake-data').count()) === 1 ? true : null), HUNG_MS)))
    const extraFile = path.join(userData, 'clis', 'fake-extra.json')
    const moved = path.join(lib.WORK, 'datacli-moved')
    fs.rmSync(moved, { recursive: true, force: true })
    fs.mkdirSync(moved, { recursive: true })
    for (const f of ['datacli.cmd', 'fake-datacli.cjs']) fs.copyFileSync(path.join(__dirname, 'fake-datacli', f), path.join(moved, f))
    fs.writeFileSync(extraFile, JSON.stringify({ ...noSession, id: 'fake-extra', name: 'Fake Extra CLI' }, null, 2))
    await inv('clis:reload')
    check('a Reload adds a new CLI: its Advanced tab', !!(await lib.until(async () => ((await advTab('fake-extra').count()) === 1 ? true : null), HUNG_MS)))
    check('…and its page', !!(await lib.until(async () => ((await navRow('Fake Extra CLI').count()) === 1 ? true : null), HUNG_MS)))
    const extraPath = async () => String((await inv('provider:info'))['fake-extra']?.path ?? '').toLowerCase()
    check('…and looks for it', !!(await lib.until(async () => ((await extraPath()).endsWith(path.join('fake-datacli', 'datacli.cmd').toLowerCase()) ? true : null), HUNG_MS)), await extraPath())
    fs.writeFileSync(extraFile, JSON.stringify({ ...noSession, id: 'fake-extra', name: 'Fake Renamed CLI', binary: { ...noSession.binary, paths: [path.join(moved, 'datacli.cmd')] } }, null, 2))
    await inv('clis:reload')
    check('a Reload with it changed renames its page', !!(await lib.until(async () => ((await navRow('Fake Renamed CLI').count()) === 1 && (await navRow('Fake Extra CLI').count()) === 0 ? true : null), HUNG_MS)))
    check('…and looks for it again where it now says it is', !!(await lib.until(async () => ((await extraPath()) === path.join(moved, 'datacli.cmd').toLowerCase() ? true : null), HUNG_MS)), await extraPath())
    fs.rmSync(extraFile)
    await inv('clis:reload')
    check('a Reload with it removed takes away its tab and page', !!(await lib.until(async () => ((await advTab('fake-extra').count()) === 0 && (await navRow('Fake Renamed CLI').count()) === 0 ? true : null), HUNG_MS)))
    await page.keyboard.press('Escape')

    const a = await lib.addAgent(inv, proj, { name: 'Data', provider: 'fake-data' })
    const live = async () => (await inv('session:live')).find((s) => s.agentId === a.id && s.status !== 'stopped') ?? null
    const statusIs = (want) => lib.until(async () => ((await live())?.status === want ? true : null), HUNG_MS, 150)
    const stopped = () => lib.until(async () => !(await live()), HUNG_MS, 150)
    const resumeId = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === proj.toLowerCase())?.agents.find((x) => x.id === a.id)?.resume?.id ?? null

    // --- A start with its first prompt: typed once its screen is ready, under Combwork's id, with the description's variables.
    fs.writeFileSync(hold, '')
    const started = await api('POST', `/v1/projects/demo/agents/${a.id}/start`, { prompt: 'first job' })
    check('POST start with a prompt starts it', started.status === 200, JSON.stringify(started))
    const first = await lib.until(async () => launches()[0], HUNG_MS)
    const sid = arg(first, '--session-id')
    check("…under Combwork's session id, its folder and the description's variables", !!sid && fs.realpathSync.native(first.cwd).toLowerCase() === fs.realpathSync.native(proj).toLowerCase() && first.env.FAKE_DATACLI_MARK === 'from-description', JSON.stringify(first))
    const typed = await lib.until(async () => lines().find((e) => e.kind === 'line' && e.text === 'first job'), HUNG_MS)
    check('…its first prompt typed once, at its prompt', !!typed && lines().filter((e) => e.kind === 'line').length === 1 && !lines().some((e) => e.kind === 'typedWhileBusy'))
    check('working, read from its screen', !!(await statusIs('working')))
    const busy = await api('POST', `/v1/projects/demo/agents/${a.id}/prompt`, { text: 'more' })
    check('…a prompt from the API is refused while it works', busy.status === 409, JSON.stringify(busy))
    fs.rmSync(hold, { force: true })
    check('…then finished, as its prompt is back', !!(await statusIs('finished')) || (await live())?.status === 'ready', (await live())?.status)

    // --- It has no inbox: a task from the API while it runs is refused, saying so, and nothing is typed.
    const noInbox = await api('POST', `/v1/projects/demo/agents/${a.id}/prompt`, { text: 'not typed' })
    check('a prompt from the API while it is idle is refused: it has no inbox', noInbox.status === 409 && /no inbox/.test(noInbox.body?.error ?? '') && !lines().some((e) => e.text === 'not typed'), JSON.stringify(noInbox))

    // --- Its question waits for the user; a prompt from the API is refused meanwhile; answered, it is ready again.
    await inv('pty:write', lib.ptyKey(proj, a.id), 'ask')
    await inv('pty:write', lib.ptyKey(proj, a.id), '\r')
    check('its question waits for the user', !!(await statusIs('waiting')))
    const asked = await api('POST', `/v1/projects/demo/agents/${a.id}/prompt`, { text: 'more' })
    check('…a prompt from the API is refused meanwhile', asked.status === 409, JSON.stringify(asked))
    await inv('pty:write', lib.ptyKey(proj, a.id), 'y')
    await inv('pty:write', lib.ptyKey(proj, a.id), '\r')
    check('…answered, it is no longer waiting', !!(await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS, 150)), (await live())?.status)

    // --- Stopped, it resumes by its id: the same session, reopened.
    await inv('session:stop', proj, a.id)
    await stopped()
    check('its Resume names the session', (await resumeId()) === sid, String(await resumeId()))
    const resumed = await api('POST', `/v1/projects/demo/agents/${a.id}/start`, { resume: true })
    const second = await lib.until(async () => launches()[1], HUNG_MS)
    check('…and resumes by it', resumed.status === 200 && arg(second, '--resume') === sid && !lines().some((e) => e.kind === 'resumeRefused'), JSON.stringify({ resumed, args: second?.args }))
    await statusIs('ready')
    await inv('session:stop', proj, a.id)
    await stopped()

    // --- A session stopped before any prompt has nothing to resume: it is dropped, and Resume names the earlier one.
    await inv('session:start', proj, { agentId: a.id })
    const third = await lib.until(async () => launches()[2], HUNG_MS)
    const thirdId = arg(third, '--session-id')
    await statusIs('ready')
    await inv('session:stop', proj, a.id)
    await stopped()
    check('a session stopped before any prompt is never resumed: Resume names the earlier conversation', !!thirdId && thirdId !== sid && (await resumeId()) === sid, String(await resumeId()))

    // --- A question answered before its first prompt is no prompt; a prompt the user types is one.
    fs.writeFileSync(trust, '')
    await inv('session:start', proj, { agentId: a.id })
    const fourth = await lib.until(async () => launches()[3], HUNG_MS)
    const fourthId = arg(fourth, '--session-id')
    check('its question before its prompt waits for the user', !!(await statusIs('waiting')))
    fs.rmSync(trust, { force: true })
    await inv('pty:write', lib.ptyKey(proj, a.id), 'y')
    await inv('pty:write', lib.ptyKey(proj, a.id), '\r')
    check('…answered, it is ready', !!(await statusIs('ready')))
    await inv('session:stop', proj, a.id)
    await stopped()
    check('…its answer is no prompt: that session is never resumed', !!fourthId && (await resumeId()) === sid, String(await resumeId()))
    await inv('session:start', proj, { agentId: a.id })
    const fifth = await lib.until(async () => launches()[4], HUNG_MS)
    const fifthId = arg(fifth, '--session-id')
    await statusIs('ready')
    await inv('pty:write', lib.ptyKey(proj, a.id), 'typed by hand')
    await inv('pty:write', lib.ptyKey(proj, a.id), '\r')
    await lib.until(async () => lines().find((e) => e.kind === 'line' && e.text === 'typed by hand'), HUNG_MS)
    await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS, 150)
    await inv('session:stop', proj, a.id)
    await stopped()
    check('…a prompt the user types is one: Resume names its session', (await resumeId()) === fifthId, String(await resumeId()))
    await api('POST', `/v1/projects/demo/agents/${a.id}/start`, { resume: true })
    const sixth = await lib.until(async () => launches()[5], HUNG_MS)
    check('…and resumes it by its id', arg(sixth, '--resume') === fifthId && !lines().some((e) => e.kind === 'resumeRefused'), JSON.stringify(sixth?.args))
    await statusIs('ready')

    // --- A first prompt waits for a safe point: a question before it, the user's answer with a draft after it, the
    // draft's own question; typed only once its prompt is free, the draft never cleared or lost, typed once.
    await inv('session:stop', proj, a.id)
    await stopped()
    fs.writeFileSync(trust, '')
    const draftStart = await api('POST', `/v1/projects/demo/agents/${a.id}/start`, { prompt: 'builder task' })
    const draftLaunch = await lib.until(async () => launches()[6], HUNG_MS)
    const draftId = arg(draftLaunch, '--session-id')
    await statusIs('waiting')
    fs.rmSync(trust, { force: true })
    const linesOf = () => lines().filter((e) => e.kind === 'line' && e.id === draftId).map((e) => e.text)
    // The answer, then a draft not sent.
    await inv('pty:write', lib.ptyKey(proj, a.id), 'y\rask')
    await lib.until(async () => (linesOf().includes('y') ? true : null), HUNG_MS)
    // The draft sent: it asks its question; answered, its prompt is free at last.
    await inv('pty:write', lib.ptyKey(proj, a.id), '\r')
    await lib.until(async () => (linesOf().includes('ask') ? true : null), HUNG_MS)
    await statusIs('waiting')
    await inv('pty:write', lib.ptyKey(proj, a.id), 'n\r')
    await lib.until(async () => (linesOf().includes('builder task') ? true : null), HUNG_MS)
    check('a first prompt waits for its question, the user’s draft and the draft’s question: then typed once', draftStart.status === 200 && JSON.stringify(linesOf()) === JSON.stringify(['y', 'ask', 'n', 'builder task']) && !lines().some((e) => e.kind === 'typedWhileBusy' && e.id === draftId), JSON.stringify({ lines: linesOf(), status: (await live())?.status, screen: lib.plainText((await inv('pty:buffer', lib.ptyKey(proj, a.id)).catch(() => '')) ?? '').slice(-400) }))
    await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS, 150)

    // --- A first prompt held only by the user's typing pause is typed when the pause ends, with nothing more on its screen.
    await inv('session:stop', proj, a.id)
    await stopped()
    fs.writeFileSync(trust, '')
    await api('POST', `/v1/projects/demo/agents/${a.id}/start`, { prompt: 'quiet task' })
    const quietLaunch = await lib.until(async () => launches()[7], HUNG_MS)
    const quietId = arg(quietLaunch, '--session-id')
    await statusIs('waiting')
    fs.rmSync(trust, { force: true })
    await inv('pty:write', lib.ptyKey(proj, a.id), 'y\r')
    const quietLines = () => lines().filter((e) => e.kind === 'line' && e.id === quietId).map((e) => e.text)
    check('a first prompt held by the typing pause alone is typed when it ends', !!(await lib.until(async () => (quietLines().includes('quiet task') ? true : null), HUNG_MS)) && JSON.stringify(quietLines()) === JSON.stringify(['y', 'quiet task']), JSON.stringify(quietLines()))
    await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS, 150)
    const draftIdKept = draftId

    // --- Combwork quits while it runs, and starts again: the session it had is kept, and resumes by its id.
    await inv('pty:write', lib.ptyKey(proj, a.id), 'before quitting')
    await inv('pty:write', lib.ptyKey(proj, a.id), '\r')
    await lib.until(async () => lines().find((e) => e.kind === 'line' && e.text === 'before quitting'), HUNG_MS)
    await lib.until(async () => (['ready', 'finished'].includes((await live())?.status) ? true : null), HUNG_MS, 150)
    await app.close()
    await boot()
    await lib.waitForProvider(inv, 'fake-data')
    check('after a restart, its Resume still names the session', (await resumeId()) === quietId && quietId !== draftIdKept, String(await resumeId()))
    const afterRestart = await api('POST', `/v1/projects/demo/agents/${a.id}/start`, { resume: true })
    const seventh = await lib.until(async () => launches()[8], HUNG_MS)
    check('…and resumes it by its id', afterRestart.status === 200 && arg(seventh, '--resume') === quietId && !lines().some((e) => e.kind === 'resumeRefused'), JSON.stringify({ afterRestart, args: seventh?.args }))
    check('…ready at its prompt', !!(await statusIs('ready')), JSON.stringify({ status: (await live())?.status, screen: lib.plainText((await inv('pty:buffer', lib.ptyKey(proj, a.id)).catch(() => '')) ?? '').slice(-300) }))
    await inv('session:stop', proj, a.id)
    await stopped()

    // --- A CLI described without a session: its session is never resumed, and a resume says so.
    const b = await lib.addAgent(inv, proj, { name: 'NoSession', provider: 'fake-nosession' })
    const liveB = async () => (await inv('session:live')).find((s) => s.agentId === b.id && s.status !== 'stopped') ?? null
    await inv('session:start', proj, { agentId: b.id })
    const eighth = await lib.until(async () => launches()[9], HUNG_MS)
    check('a CLI without a session starts with no session id', !!eighth && !eighth.args.includes('--session-id'), JSON.stringify(eighth?.args))
    check('…and is ready at its prompt', !!(await lib.until(async () => ((await liveB())?.status === 'ready' ? true : null), HUNG_MS, 150)), JSON.stringify({ status: (await liveB())?.status, screen: lib.plainText((await inv('pty:buffer', lib.ptyKey(proj, b.id)).catch(() => '')) ?? '').slice(-300) }))
    await inv('pty:write', lib.ptyKey(proj, b.id), 'no session here')
    await inv('pty:write', lib.ptyKey(proj, b.id), '\r')
    await lib.until(async () => lines().find((e) => e.kind === 'line' && e.text === 'no session here'), HUNG_MS)
    await lib.until(async () => (['ready', 'finished'].includes((await liveB())?.status) ? true : null), HUNG_MS, 150)
    await inv('session:stop', proj, b.id)
    await lib.until(async () => !(await liveB()), HUNG_MS, 150)
    const noResume = await api('POST', `/v1/projects/demo/agents/${b.id}/start`, { resume: true })
    check('…and a resume of it is refused, saying there is none', noResume.status === 409 && launches().length === 10, JSON.stringify(noResume))

    // --- A launch held while it prepares, its CLI's description removed and reloaded meanwhile: it launches from the
    // copy it took (its arguments), not refused as turned off; the next start is refused (its CLI is gone).
    const c = await lib.addAgent(inv, proj, { name: 'Held', provider: 'fake-held' })
    const liveC = async () => (await inv('session:live')).find((x) => x.agentId === c.id && x.status !== 'stopped') ?? null
    fs.writeFileSync(holdLaunch, '')
    const heldStart = inv('session:start', proj, { agentId: c.id }).then(() => 'started', (e) => `refused: ${e.message}`)
    await lib.until(async () => (fs.existsSync(`${holdLaunch}.held`) ? true : null), HUNG_MS)
    fs.rmSync(path.join(userData, 'clis', 'fake-held.json'))
    await inv('clis:reload')
    await lib.until(async () => (!(await inv('clis:snapshot')).clis.some((x) => x.id === 'fake-held') ? true : null), HUNG_MS)
    fs.rmSync(holdLaunch)
    const heldOutcome = await heldStart
    const heldLaunch = await lib.until(async () => launches().find((e) => arg(e, '--from') === 'first'), HUNG_MS)
    check('a launch whose description is removed while it prepares launches from its own copy', heldOutcome === 'started' && !!heldLaunch, JSON.stringify({ heldOutcome, args: heldLaunch?.args }))
    check('…and runs on it: ready at its prompt', !!(await lib.until(async () => ((await liveC())?.status === 'ready' ? true : null), HUNG_MS, 150)), JSON.stringify({ status: (await liveC())?.status, screen: lib.plainText((await inv('pty:buffer', lib.ptyKey(proj, c.id)).catch(() => '')) ?? '').slice(-300) }))
    await inv('session:stop', proj, c.id)
    await lib.until(async () => !(await liveC()), HUNG_MS, 150)
    const after = await inv('session:start', proj, { agentId: c.id }).then(() => 'started', (e) => String(e.message))
    check('…and the next start is refused: its CLI is gone', /Unknown provider/.test(after), after)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
