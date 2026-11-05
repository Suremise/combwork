// An expired CLI sign-in in running sessions (#309). The fake Claude Code acts out Claude Code 2.1.291 with an expired
// sign-in (fake-signin.json in its test home: each turn ends with StopFailure authentication_failed, `auth status` says
// signed out): the agents show "needs sign-in", one notification is recorded for all of them, "/login" in one agent's
// terminal carries that agent on by itself and ends it for all, and Resume (n) carries on the others with a short prompt.
// A later expiry is told again. Quiet test build (HIVE_TEST_NOTIFY_LOG), throwaway profile, workspace and test home;
// no real sign-in is touched.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'signin-profile')
const ws = path.join(lib.WORK, 'signin-ws')
const claudeHome = path.join(lib.WORK, 'signin-claude-home')
const alpha = path.join(ws, 'alpha')
const shots = path.join(lib.WORK, 'signin-shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, chimeEnabled: true, chimeVolume: 0, desktopNotifications: true, notifyOnFinished: true, notifyOnWaiting: true, onlyWhenUnfocused: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const notifyLog = path.join(lib.WORK, 'signin-notify.log')
  fs.rmSync(notifyLog, { force: true })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47919), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_QUIET: '1', HIVE_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await app.evaluate(({ Notification }) => {
    Notification.isSupported = () => true
  })
  // The sign-in notifications Combwork would have shown (a finish is told too, separately).
  const signInNotes = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'notification' && /sign in/i.test(e.title ?? ''))
  const expire = (expired) => fs.writeFileSync(path.join(claudeHome, 'fake-signin.json'), JSON.stringify({ expired }))

  const agents = []
  for (const name of ['Ada', 'Bo', 'Cy']) agents.push(await lib.addAgent(inv, alpha, { name }))
  const live = async (a) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === a.id)
  const all = async () => Promise.all(agents.map(live))
  for (const a of agents) await inv('session:start', alpha, { agentId: a.id })
  check('three agents start', !!(await until(async () => (await all()).every((s) => s?.status === 'ready'), 25000)))
  await page.getByText('alpha', { exact: true }).first().click()
  const send = async (a, text) => {
    await inv('pty:write', lib.ptyKey(alpha, a.id), text)
    await lib.sleep(100)
    await inv('pty:write', lib.ptyKey(alpha, a.id), '\r')
  }

  // --- The sign-in expires: every agent's next turn is refused.
  expire(true)
  for (const a of agents) await send(a, 'go on with the task')
  check('each shows needs sign-in', !!(await until(async () => (await all()).every((s) => s?.status === 'signin'), 15000)), JSON.stringify((await all()).map((s) => s?.status)))
  const states = await all()
  check("each keeps the CLI's message beside its status", states.every((s) => s?.signIn?.message === 'Login expired · Please run /login' && !s.statusMessage), JSON.stringify(states.map((s) => [s?.signIn, s?.statusMessage])))
  await lib.sleep(4500) // A fixed wait on purpose: it waits out the gathering window (agents refused together are told in one notification) to show only one arrives.
  const told = signInNotes()
  check('one notification for the three', told.length === 1, JSON.stringify(told))
  check('it counts them and says how to sign in', told[0]?.title === '3 agents need you to sign in to Claude Code' && /\/login/.test(told[0]?.body ?? '') && /Provider Setup/.test(told[0]?.body ?? ''), JSON.stringify(told[0]))
  const info = await until(async () => {
    const i = (await inv('provider:info'))['claude-code']
    return i && !i.checking && i.loggedIn === false ? i : null
  }, 15000)
  check('Provider Setup shows Claude Code signed out', !!info && (info.readiness ?? []).some((r) => r.id === 'signed-out'), JSON.stringify(info?.readiness))
  // Each pane's mark: waiting for you, a diamond (#973; the agent strip's sign-in dots went with it, #975).
  const marks = await until(async () => ((await page.locator('.pane-header-bar .state-mark.waiting').count()) >= 3 ? true : null), 5000)
  check('the panes mark the three as waiting for you', !!marks, String(await page.locator('.pane-header-bar .state-mark.waiting').count()))
  check('the pane header says Needs sign-in', (await page.locator('.pane-status.signin', { hasText: 'Needs sign-in' }).count()) >= 1)
  check('Resume (n) counts the three', (await page.locator('.project-header button.act-resume', { hasText: 'Resume (3)' }).count()) === 1)
  await page.screenshot({ path: path.join(shots, 'signin-1-needs-sign-in.png') })
  // Another turn refused in the same expiry is shown, never told again.
  await send(agents[0], 'try once more')
  await until(async () => (await live(agents[0]))?.status === 'working', HUNG_MS)
  await until(async () => (await live(agents[0]))?.status === 'signin', 10000)
  await lib.sleep(4000) // A fixed wait on purpose: a second notification would arrive within the gathering window.
  check('a later refusal in the same expiry is not told again', signInNotes().length === 1, JSON.stringify(signInNotes()))

  // --- /login in Ada's terminal: Ada carries on by itself; the others are idle again, for Resume (n).
  await send(agents[0], '/login')
  check('the agent signed in from its terminal carries on and finishes', !!(await until(async () => (await live(agents[0]))?.status === 'finished', 15000)), (await live(agents[0]))?.status)
  check('its sign-in mark goes', !(await live(agents[0]))?.signIn)
  const others = await until(async () => {
    const s = await Promise.all(agents.slice(1).map(live))
    return s.every((x) => x?.status === 'ready') ? s : null
  }, 10000)
  check('the others are idle again, marked as stopped by the sign-in', !!others && others.every((s) => s.signIn && s.statusMessage === 'Stopped while signed out'), JSON.stringify((others ?? []).map((s) => [s?.status, s?.statusMessage, !!s?.signIn])))
  check('Combwork says so, counting only the two it stopped', !!(await until(async () => ((await page.getByText("2 agents stopped while it was signed out: Resume in the project's header carries them on.").count()) ? true : null), 5000)))
  const back = await until(async () => {
    const i = (await inv('provider:info'))['claude-code']
    return i && !i.checking && i.loggedIn === true ? i : null
  }, 15000)
  check('Provider Setup shows it signed in again', !!back && !(back.readiness ?? []).some((r) => r.id === 'signed-out'), JSON.stringify(back?.readiness))
  const resume = page.locator('.project-header button.act-resume', { hasText: 'Resume (2)' })
  check('Resume (n) counts the two still stopped', (await until(async () => ((await resume.count()) === 1 ? true : null), 5000)) === true)
  await page.screenshot({ path: path.join(shots, 'signin-2-signed-in-again.png') })

  // --- Resume (n): a short "carry on" in each, and they finish.
  await resume.click()
  const carried = await until(async () => (await Promise.all(agents.slice(1).map(live))).every((s) => s?.status === 'finished'), 15000)
  check('Resume (n) carries the two on and they finish', !!carried, JSON.stringify((await Promise.all(agents.slice(1).map(live))).map((s) => s?.status)))
  for (const a of agents.slice(1)) {
    const screen = lib.plainText(await inv('pty:buffer', lib.ptyKey(alpha, a.id)))
    check(`${a.name} was told to carry on`, /carry on where you left off/.test(screen), screen.slice(-300))
  }
  check('Ada, already carrying on, got no prompt', !/carry on where you left off/.test(lib.plainText(await inv('pty:buffer', lib.ptyKey(alpha, agents[0].id)))))
  check('no agent is left marked', (await all()).every((s) => !s?.signIn))
  check('Resume (n) is gone', (await page.getByRole('button', { name: /^Resume/ }).count()) === 0)

  // --- A new expiry is told again.
  expire(true)
  await send(agents[1], 'next task')
  check('a later expiry shows needs sign-in', !!(await until(async () => (await live(agents[1]))?.status === 'signin', 10000)))
  check('and is told again, for its one agent', !!(await until(async () => (signInNotes().length === 2 ? true : null), 8000)) && /^alpha · Bo needs you to sign in to Claude Code$/.test(signInNotes()[1]?.title ?? ''), JSON.stringify(signInNotes()))

  await app.close()
  if (failed) process.exitCode = 1
})().catch((e) => {
  console.log(`FAIL suite crashed: ${e?.stack ?? e}`)
  process.exitCode = 1
})
