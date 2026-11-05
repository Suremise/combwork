// Who a Codex agent asks: Combwork says an agent needs you only while a person is asked. Codex's auto-reviewer answering
// a permission request (Approve for me) isn't you being asked; an approval prompt is (waiting, told once, over once
// answered); an async question is asked while Codex works on (a pending question, told once, gone once answered).
// The fake Codex (fake-codex/) sends Codex 0.160.0's hooks and terminal titles. Dev build, throwaway profile,
// workspace and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'attention-profile')
const ws = path.join(lib.WORK, 'attention-ws')
const codexHome = path.join(lib.WORK, 'attention-codex-home')
const proj = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(codexHome, { recursive: true })
  // The non-admin sandbox is set up, so Codex has nothing left to set up.
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // Told by the chime and the log here, not desktop notifications.
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47897), CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(100)
    return v
  }
  const info = await lib.waitForProvider(inv, 'codex')
  check('the fake Codex is found, signed in, as 0.160.0', info.version === '0.160.0' && info.loggedIn === true, JSON.stringify(info))
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()

  const reviewed = await lib.addAgent(inv, proj, { name: 'Reviewed', provider: 'codex', permissionMode: 'approve-for-me' })
  const asking = await lib.addAgent(inv, proj, { name: 'Asking', provider: 'codex', permissionMode: 'ask' })
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  for (const a of [reviewed, asking]) await inv('session:start', proj, { agentId: a.id })
  check('the agents start', !!(await until(async () => (await live(reviewed.id))?.status === 'ready' && (await live(asking.id))?.status === 'ready', 20000)), `${(await live(reviewed.id))?.status} ${(await live(asking.id))?.status}`)
  check('in their modes', (await live(reviewed.id))?.permissionMode === 'approve-for-me' && (await live(asking.id))?.permissionMode === 'ask', `${(await live(reviewed.id))?.permissionMode} ${(await live(asking.id))?.permissionMode}`)

  // Every state an agent goes through (status | message | question | review), and the times Combwork says it needs you (the log).
  const seen = new Map()
  const watch = setInterval(async () => {
    try {
      for (const s of await inv('session:live')) {
        const list = seen.get(s.agentId) ?? []
        const now = `${s.status}|${s.statusMessage ?? ''}|${s.question?.text ?? ''}|${s.review ?? ''}`
        if (list[list.length - 1] !== now) list.push(now)
        seen.set(s.agentId, list)
      }
    } catch {
      // The window is closing.
    }
  }, 60)
  const logText = () => fs.readFileSync(path.join(userData, 'logs', 'combwork.log'), 'utf8')
  const told = (name) => logText().split('\n').filter((l) => l.includes(`· ${name}`) && /waits for you|asks a question/.test(l)).length
  const turn = async (a, text) => {
    seen.set(a.id, [])
    const key = lib.ptyKey(proj, a.id)
    await inv('pty:write', key, text)
    await lib.sleep(150)
    await inv('pty:write', key, '\r')
    // Under way, so a wait for it to finish isn't answered by the turn before.
    await until(async () => states(a).some((s) => s.startsWith('working')), 5000)
  }
  const finished = (a, ms = 15000) => until(async () => (await live(a.id))?.status === 'finished', ms)
  const states = (a) => seen.get(a.id) ?? []

  // --- Approve for me: the auto-reviewer answers; nobody is asked. Its pane says Working…, with a review mark whose
  // details (what is asked) show on hover; the request is never the status.
  const header = page.locator('.pane-header-bar', { hasText: 'Reviewed' })
  const mark = header.locator('.review-mark')
  const status = () => header.locator('.pane-status').innerText().catch(() => '')
  const underReview = (s) => /^working\|\|[^|]*\|Codex asks to run /.test(s)
  const neverStatus = (a) => !states(a).some((s) => s.split('|')[1].includes('Codex asks'))
  await turn(reviewed, 'review allow')
  check('under review: its status still says Working…, with the review mark', !!(await until(async () => (await mark.isVisible().catch(() => false)) && (await status()) === 'Working…', HUNG_MS)), await status())
  check('an approved auto-review finishes the turn', !!(await finished(reviewed)))
  check('and the mark goes', (await mark.count()) === 0)
  check('it was under review, with what was asked', states(reviewed).some(underReview), states(reviewed).join(' > '))
  check('never as its status message', neverStatus(reviewed), states(reviewed).join(' > '))
  check('and never that it needed you', !states(reviewed).some((s) => s.startsWith('waiting')) && told('Reviewed') === 0, states(reviewed).join(' > '))
  await turn(reviewed, 'review deny')
  check('a denied one too', !!(await finished(reviewed)) && !states(reviewed).some((s) => s.startsWith('waiting')) && told('Reviewed') === 0, states(reviewed).join(' > '))
  check('its review gone with the next command', (await live(reviewed.id))?.review === undefined && (await mark.count()) === 0)

  // --- A long command under review (an environment variable, a path): the header stays short and readable, wide
  // and narrow, dark and light; the command is only in the mark's tooltip.
  for (const [width, theme] of [[1400, 'dark'], [820, 'light']]) {
    await inv('settings:update', { appearance: { theme } })
    await lib.fitWindow(app, page, { width, height: 850 })
    await turn(reviewed, 'review long')
    const t0 = Date.now()
    const shown = await until(async () => mark.isVisible().catch(() => false), HUNG_MS)
    const text = await header.innerText().catch(() => '')
    check(`${width}px ${theme}: the long request is under review`, !!shown && (await status()) === 'Working…', await status())
    check(`${width}px ${theme}: none of it in the header`, !/\$env|npm\.cmd|combwork-test|Codex asks/.test(text), text.replace(/\s+/g, ' '))
    check(`${width}px ${theme}: the header fits, its buttons inside it`, await header.evaluate((h) => h.scrollWidth <= h.clientWidth + 1 && [...h.querySelectorAll('button')].every((b) => b.getBoundingClientRect().right <= h.getBoundingClientRect().right + 1)))
    const tip = page.locator('.tip', { hasText: 'npm.cmd run e2e' })
    const hovered = await until(async () => {
      await mark.hover({ timeout: 500 }).catch(() => undefined)
      return (await tip.count()) === 1
    }, HUNG_MS)
    check(`${width}px ${theme}: the details on hover: the reviewer, and what it asks`, !!hovered && /reviewer is checking/.test(await tip.innerText()), `mark visible: ${await mark.isVisible().catch(() => false)}; tips: ${await page.locator('.tip').allInnerTexts().then((t) => t.join(' | '))}; ${Date.now() - t0} ms; ${states(reviewed).join(' > ')}`)
    await page.screenshot({ path: path.join(lib.WORK, `attention-review-${width}-${theme}.png`) })
    await page.mouse.move(5, 5)
    check(`${width}px ${theme}: approved, the mark goes`, !!(await finished(reviewed)) && (await mark.count()) === 0)
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await lib.fitWindow(app, page, { width: 1400, height: 850 })

  // --- Ask for approval: the prompt is up: waiting, told once (the title blinks meanwhile), over when answered.
  const askKey = lib.ptyKey(proj, asking.id)
  await turn(asking, 'approve')
  check('an approval prompt is waiting for you', !!(await until(async () => (await live(asking.id))?.status === 'waiting', 5000)))
  check('with what it asks', (await live(asking.id))?.statusMessage === 'Codex asks to run curl.exe https://example.com', (await live(asking.id))?.statusMessage)
  await lib.sleep(1600) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('told once, though its title blinks', told('Asking') === 1, String(told('Asking')))
  // The inbox (finishes the window hasn't shown yet may be listed with it).
  await page.locator('[data-inbox-toggle]').click()
  check('the inbox says it needs input', !!(await until(() => page.getByText('Needs input: Codex asks to run curl.exe https://example.com').isVisible().catch(() => false), HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'attention-1-approval.png') })
  await page.keyboard.press('Escape')
  await inv('pty:write', askKey, 'y')
  check('approved: it works on, and finishes', !!(await finished(asking)))
  check('no longer waiting', !states(asking).slice(states(asking).findIndex((s) => s.startsWith('waiting')) + 1).some((s) => s.startsWith('waiting')), states(asking).join(' > '))
  await turn(asking, 'approve')
  await until(async () => (await live(asking.id))?.status === 'waiting', 5000)
  await inv('pty:write', askKey, '\x1b')
  check('rejected (Esc): ready again, not waiting', !!(await until(async () => (await live(asking.id))?.status === 'ready', 5000)), (await live(asking.id))?.status)
  check('told once for that prompt', told('Asking') === 2, String(told('Asking')))

  // --- An async question: it works on, with the question pending, told once, until answered.
  await turn(reviewed, 'question')
  check('a question is pending', !!(await until(async () => (await live(reviewed.id))?.question?.text === 'Which colour?', 5000)))
  check('while it works on', (await live(reviewed.id))?.status === 'working')
  await lib.sleep(1600) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
  check('told once', told('Reviewed') === 1, String(told('Reviewed')))
  check('never waiting', !states(reviewed).some((s) => s.startsWith('waiting')), states(reviewed).join(' > '))
  check('its pane says so', !!(await until(() => page.locator('.pane-status.asks', { hasText: 'has a question for you' }).isVisible().catch(() => false), HUNG_MS)))
  check('it needs you in the status bar', await page.locator('[data-inbox-toggle]', { hasText: /needs? you/ }).isVisible().catch(() => false))
  await page.locator('[data-inbox-toggle]').click()
  check('the inbox shows the question', !!(await until(() => page.getByText('Asks: Which colour?').isVisible().catch(() => false), HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'attention-2-question.png') })
  await page.keyboard.press('Escape')
  await inv('pty:write', lib.ptyKey(proj, reviewed.id), 'a')
  check('answered: the question goes', !!(await until(async () => !(await live(reviewed.id))?.question, 5000)))
  check('and the turn finishes', !!(await finished(reviewed)))
  check('neither agent asks anything now', (await inv('session:live')).every((s) => !s.question && s.status !== 'waiting'))

  // --- With a question pending, the title is already on: it can't say a later request is put to you.
  const reviewedKey = lib.ptyKey(proj, reviewed.id)
  for (const outcome of ['allow', 'deny']) {
    const before = told('Reviewed')
    await turn(reviewed, `question then review ${outcome}`)
    check(`question + auto-review ${outcome}: the question is pending`, !!(await until(async () => (await live(reviewed.id))?.question?.text === 'Which colour?', 5000)))
    // The review comes and goes; the agent works on, the question pending, and you aren't told again.
    await until(async () => (await live(reviewed.id))?.review === undefined && states(reviewed).some(underReview), 5000)
    await lib.sleep(1200) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
    check(`question + auto-review ${outcome}: never waiting, told only of the question`, !states(reviewed).some((s) => s.startsWith('waiting')) && told('Reviewed') === before + 1, `${told('Reviewed') - before} · ${states(reviewed).join(' > ')}`)
    check(`question + auto-review ${outcome}: still working, the question still pending`, (await live(reviewed.id))?.status === 'working' && (await live(reviewed.id))?.question?.text === 'Which colour?')
    await inv('pty:write', reviewedKey, 'a')
    check(`question + auto-review ${outcome}: answered, it finishes`, !!(await finished(reviewed)) && !(await live(reviewed.id))?.question)
  }
  // --- A finished review is resolved: a later question (its title even before its hook) is the question.
  for (const outcome of ['allow', 'deny']) {
    const before = told('Reviewed')
    await turn(reviewed, `review ${outcome} then late question`)
    check(`auto-review ${outcome}, then a question titled before its hook: the question shows`, !!(await until(async () => (await live(reviewed.id))?.question?.text === 'Which colour?', 8000)))
    await lib.sleep(1200) // A fixed wait on purpose: this checks that something does NOT happen, which no condition can show.
    const l = await live(reviewed.id)
    check(`auto-review ${outcome}, then a question: working, not waiting on the finished review`, l?.status === 'working' && !states(reviewed).some((x) => x.startsWith('waiting|Codex asks')), states(reviewed).join(' > '))
    check(`auto-review ${outcome}, then a question: told once`, told('Reviewed') === before + 1, String(told('Reviewed') - before))
    await inv('pty:write', reviewedKey, 'a')
    check(`auto-review ${outcome}, then a question: answered, it finishes`, !!(await finished(reviewed)) && !(await live(reviewed.id))?.question)
  }
  {
    const before = told('Asking')
    // The question first, told on its own, then the prompt: a new need, told too. The fake holds before the prompt until
    // Combwork shows the question (#329): sent at once, the prompt's hooks could reach Combwork before Codex's title (its sign
    // that a person must act) said the question was asked, and both then came on with the title, rightly told together
    // in one notice.
    await turn(asking, 'question then hold then approve')
    check('question: shown and told on its own first', !!(await until(async () => (await live(asking.id))?.question?.text === 'Which colour?' && told('Asking') === before + 1, 5000)), String(told('Asking') - before))
    await inv('pty:write', askKey, 'g')
    check('question + approval prompt: waiting, with the question beside it', !!(await until(async () => (await live(asking.id))?.status === 'waiting' && (await live(asking.id))?.question?.text === 'Which colour?', 5000)))
    await lib.sleep(1200) // A fixed wait on purpose: the count must not rise past two, which no condition can show.
    check('told of both: the prompt is a new need', told('Asking') === before + 2, String(told('Asking') - before))
    await inv('pty:write', askKey, 'y')
    // Approved: its own command ends (after another beside it), though the question keeps the title on.
    check('approved: working again, the question still pending', !!(await until(async () => (await live(asking.id))?.status === 'working', 5000)) && (await live(asking.id))?.question?.text === 'Which colour?', JSON.stringify(await live(asking.id)))
    await page.screenshot({ path: path.join(lib.WORK, 'attention-3-both.png') })
    await inv('pty:write', askKey, 'a')
    check('the question answered: it finishes, nothing pending', !!(await finished(asking)) && !(await live(asking.id))?.question)
  }

  clearInterval(watch)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
