// The Progress panel shows the gates (#1279), on fake Claude Code agents with the workflow rules on (a reviewer agent, a
// check needed before Review, each card in a folder of its own): a lane card started before the one before it is Done is
// refused, and its segment gets a red notch whose hover (and accessible name) says why and what next; a failed run of
// that check says it blocks review for the card; the submit it refuses notches that card's segment, and the next move
// clears it; a card passed but not merged pauses the lane, its header saying why; a new revision after the pass marks
// the segment stale with both revisions; the user's move past the rules shows its mark with who, which rule and why. Its
// screenshots in both themes and in German. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and B1 is a 0.9 worktree agent (agents:testLegacy,
// refused by a packaged build), its card's folder.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47841))
const userData = path.join(lib.WORK, 'progressgates-profile')
const ws = path.join(lib.WORK, 'progressgates-ws')
const claudeHome = path.join(lib.WORK, 'progressgates-claude-home')
const shots = path.join(lib.WORK, 'progressgates-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 200)
const gitIn = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: lib.gitEnv(), encoding: 'utf8' }).trim()

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  // Every read of the agents' input recorded, for typeLine.
  lib.logFakeInput(claudeHome)
  // ok.txt is what the check looks for: ignored, so making it leaves the folder clean (a dirty one wouldn't count).
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', '.gitignore': '.combwork/\nok.txt\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    // A reviewer agent who isn't the builder; the check "quick" before Review; each card in a folder of its own (in the
    // app, the builder's own worktree, until slots).
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'slots', preChecks: ['quick'], commands: { quick: `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"` } } })
    const builder = await lib.addAgent(inv, alpha, { name: 'B1', location: 'new-worktree' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'R1' })
    fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws, alpha, builder.worktree?.path].filter(Boolean).map((d) => d.toLowerCase())))
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await until(async () => (await live(builder.id))?.status === 'ready' && (await live(reviewer.id))?.status === 'ready', HUNG_MS)))

    // Each agent's own token, from its launch, as its Combwork tools read it.
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (id) => {
      const sessionId = (await live(id))?.sessionId
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const tokens = { builder: await tokenOf(builder.id), reviewer: await tokenOf(reviewer.id) }
    check('each agent has its own token', !!tokens.builder && !!tokens.reviewer && tokens.builder !== tokens.reviewer)
    const call = async (token, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const asBuilder = (p, body) => call(tokens.builder, p, body)
    const asReviewer = (p, body) => call(tokens.reviewer, p, body)
    // The agent's shell (the fake's "shell:" step), as cw-progress runs in a session.
    const shells = () => {
      const f = path.join(claudeHome, 'fake-shell.jsonl')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    // Typed again when a wake of Combwork's (the lane's) disturbed it (typeLine).
    const shell = async (id, cmd) => {
      const before = shells().length
      const name = id === builder.id ? 'B1' : 'R1'
      await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, name, `shell: ${cmd}`, { ready: async () => (await live(id))?.status !== 'working', live: () => live(id), hungMs: 60000 })
      return until(() => shells().slice(before).find((s) => s.cmd === cmd), 60000)
    }

    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const a = (await inv('tasks:create', { title: 'Lane data', project: 'alpha' })).number
    const b = (await inv('tasks:create', { title: 'Lane hover', project: 'alpha' })).number
    const [keyA, keyB] = [(await card(a)).key, (await card(b)).key]
    // A long lane (HR6's rounds 1 and 2): 25 cards more, so once A is finished it folds into "✓ 1" (its stale pass and
    // its override are read there) and the last cards into "+n".
    const extra = []
    for (let i = 1; i <= 25; i++) extra.push((await inv('tasks:create', { title: `More ${i}`, project: 'alpha' })).number)
    const lane = await call(tokens.builder, '/v1/lanes', { cards: [a, b, ...extra], reviewer: 'R1', name: 'gates' })
    check('the builder starts its lane', lane.status === 200 && !!lane.body?.lane?.id && lane.body.lane.cards?.length === 27, JSON.stringify(lane.body?.lane?.cards?.length))
    const laneId = lane.body?.lane?.id

    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click()
    check('the panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
    const row = panel.locator(`.progress-lane[data-lane="${laneId}"]`)
    const seg = (n) => row.locator(`.lane-seg[data-card="${n}"]`)
    const name = async (n) => (await seg(n).getAttribute('aria-label').catch(() => null)) ?? ''
    const header = async () => ((await row.locator('.progress-lane-top').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    check('the lane shows', !!(await until(async () => (await row.count()) === 1, HUNG_MS)))
    const shoot = async (shot) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.screenshot({ path: path.join(shots, `${shot}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    /** A segment's hover shown (a card's number, or a locator), for a screenshot: its tooltip holds every line. */
    // Hovered again while it doesn't say so yet: a segment drawn again under a still pointer (the badges read again
    // after a board change) gets no new pointer enter, so its tooltip would never open.
    const hover = async (n, has) => {
      const target = typeof n === 'number' ? seg(n) : n
      return until(async () => {
        if (((await page.locator('.lane-seg-tip').textContent().catch(() => '')) ?? '').includes(has)) return true
        await page.mouse.move(5, 5)
        await target.hover()
        // Short: past it, hovered again (the outer wait is the bound for a hung run).
        return until(async () => ((await page.locator('.lane-seg-tip').textContent().catch(() => '')) ?? '').includes(has), 2000)
      }, HUNG_MS)
    }
    const fin = row.locator('.lane-seg.finished')
    const more = row.locator('.lane-seg.more')
    const label = async (loc) => (await loc.getAttribute('aria-label').catch(() => null)) ?? ''

    // --- One card at a time: B before A is Done is refused, and its segment says so.
    const early = await asBuilder(`/v1/tasks/${encodeURIComponent(keyB)}/start`)
    check('starting the lane\'s second card first is refused (lane.oneAtATime)', early.status === 409 && early.body?.rule === 'lane.oneAtATime', JSON.stringify(early.body))
    check('…its segment gets the refused notch', !!(await until(async () => (await seg(b).locator('.lane-seg-mark.refused').count()) === 1, HUNG_MS)))
    check('…and its accessible name says why and what next, as the agent was told', !!(await until(async () => (await name(b)).includes(`${keyB} can't start yet: ${keyA}, before it in its lane, isn't Done.`), HUNG_MS)), await name(b))

    // --- A starts, in a folder of its own.
    const started = await asBuilder(`/v1/tasks/${encodeURIComponent(keyA)}/start`)
    const slot = started.body?.data?.folder
    check('the lane\'s first card starts in a folder of its own', started.status === 200 && !!slot && slot.toLowerCase() !== alpha.toLowerCase(), JSON.stringify(started.body))
    check('…which is ready', !!(await until(() => fs.existsSync(path.join(slot, 'a.ts')), HUNG_MS)), slot)
    fs.writeFileSync(path.join(slot, 'b.ts'), 'export const b = 2\n')
    gitIn(slot, 'add', 'b.ts')
    gitIn(slot, 'commit', '-qm', 'Lane data')
    const first = gitIn(slot, 'rev-parse', 'HEAD')

    // --- Its check fails: the run says it blocks review for A.
    const failedRun = await shell(builder.id, `cd /d "${slot}" && cw-progress --check quick`)
    check('the check fails', failedRun?.code === 1, JSON.stringify(failedRun))
    const blocks = panel.locator('.progress-run-blocks')
    check('…and its row says it blocks review for the card', !!(await until(async () => ((await blocks.first().textContent().catch(() => '')) ?? '') === `Blocks review for ${keyA}`, HUNG_MS)), await blocks.first().textContent().catch(() => ''))

    // --- Submitted without it passing: refused, the card's segment notched with the reason.
    const refused = await asBuilder(`/v1/tasks/${encodeURIComponent(keyA)}/submit`, { summary: 'Round 1 ready' })
    check('the submit is refused (submit.checksPassed)', refused.status === 409 && refused.body?.rule === 'submit.checksPassed', JSON.stringify(refused.body))
    check("…the card's segment gets the refused notch, its name the reason", !!(await until(async () => (await seg(a).locator('.lane-seg-mark.refused').count()) === 1 && (await name(a)).includes("Review refused: quick hasn't passed on"), HUNG_MS)), await name(a))
    await page.mouse.move(5, 5)
    check('…said in its hover too', !!(await hover(a, "Review refused: quick hasn't passed on")))
    await shoot('refused')
    await page.mouse.move(5, 5)

    // --- The check passes, the submit goes through: the notch clears with the move.
    fs.writeFileSync(path.join(slot, 'ok.txt'), 'yes\n')
    const passedRun = await shell(builder.id, `cd /d "${slot}" && cw-progress --check quick`)
    check('the check passes', passedRun?.code === 0, JSON.stringify(passedRun))
    await until(async () => (await inv('tasks:work', a))?.checks.some((c) => c.name === 'quick' && c.result === 'passed' && c.counted), HUNG_MS)
    const submitted = await asBuilder(`/v1/tasks/${encodeURIComponent(keyA)}/submit`, { summary: 'Round 1 ready' })
    check('then the submit goes through, to Review', submitted.status === 200 && submitted.body?.to === 'review', JSON.stringify(submitted.body))
    check("…and the card's notch clears with its move", !!(await until(async () => (await seg(a).locator('.lane-seg-mark.refused').count()) === 0, HUNG_MS)), await name(a))

    // --- Passed, not merged: the lane pauses, and says why.
    const review = await asReviewer(`/v1/tasks/${encodeURIComponent(keyA)}/start-review`)
    const pass = await asReviewer(`/v1/tasks/${encodeURIComponent(keyA)}/verdict`, { pass: true, comment: 'Round 1: PASSED.' })
    check('the reviewer passes it', review.status === 200 && pass.status === 200, JSON.stringify({ review: review.body, pass: pass.body }))
    const why = async () => (await row.locator('.progress-lane-why').textContent().catch(() => '')) ?? ''
    check('…the lane pauses, its header saying why', !!(await until(async () => (await why()) === `waiting: ${keyA} not merged` && (await row.locator('.progress-lane-why.paused').count()) === 1, HUNG_MS)), `${await header()} | ${await why()}`)
    check("…and its accessible name too", !!(await until(async () => ((await row.getAttribute('aria-label')) ?? '').includes(`paused, waiting: ${keyA} not merged`), HUNG_MS)), await row.getAttribute('aria-label'))
    await shoot('paused')

    check('the passed card folds into ✓ 1', !!(await until(async () => (await fin.count()) === 1 && (await seg(a).count()) === 0, HUNG_MS)), await label(fin))

    // --- A new revision after the pass: stale, with both revisions, on the folded segment (HR6's round 2: drawn, not
    // only named).
    fs.writeFileSync(path.join(slot, 'b.ts'), 'export const b = 3\n')
    gitIn(slot, 'commit', '-qam', 'Another change')
    const second = gitIn(slot, 'rev-parse', 'HEAD')
    // Its Work section read once (as the card dialog does): Combwork looks at its folder soon, once events settle. Asked
    // again on every poll, that "soon" would keep moving.
    await inv('tasks:work', a)
    check('a new revision after the pass marks the folded segment stale', !!(await until(async () => (await fin.getAttribute('class'))?.includes('stale'), HUNG_MS)), await fin.getAttribute('class'))
    const drawn = await fin.evaluate((el) => getComputedStyle(el).backgroundImage)
    check('…drawn: its amber dashed edges over the finished fill', /repeating-linear-gradient/.test(drawn), drawn)
    check('…its name naming the card, the revision it was for and the one now', (await label(fin)).includes(`${keyA}: Pass was for ${first.slice(0, 7)}; now at ${second.slice(0, 7)}`), await label(fin))
    check('…said in its hover too', !!(await hover(fin, `Pass was for ${first.slice(0, 7)}`)))
    await shoot('stale')
    await page.mouse.move(5, 5)

    // --- The user moves it past its rules: the override's mark, with who, which rule and why.
    const moved = await inv('tasks:move', a, 'done', { confirm: true, reason: 'Merged by hand' })
    check('the user moves it to Done past its rules', !!(await until(async () => (await card(a))?.column === 'done', HUNG_MS)), JSON.stringify(moved))
    check('…its folded segment shows the override mark, and no longer the stale one', !!(await until(async () => (await fin.locator('.lane-seg-mark.override').count()) === 1 && !(await fin.getAttribute('class'))?.includes('stale'), HUNG_MS)), await fin.getAttribute('class'))
    check('…its name saying who, past which rules and why', /: You moved it past its rules: .+\. Reason: Merged by hand/.test(await label(fin)), await label(fin))
    check('…said in its hover too', !!(await hover(fin, 'Reason: Merged by hand')))
    await shoot('override')
    await page.mouse.move(5, 5)

    // --- The last card, refused, folded into "+n" (HR6's round 1): it keeps its notch and says why.
    const last = extra.at(-1)
    const lastKey = (await card(last)).key
    const lateStart = await asBuilder(`/v1/tasks/${encodeURIComponent(lastKey)}/start`)
    check('the last card started first is refused', lateStart.status === 409 && lateStart.body?.rule === 'lane.oneAtATime', JSON.stringify(lateStart.body))
    check('the refused card folds into +n, keeping its notch and saying why', !!(await until(async () => (await more.count()) === 1 && (await more.locator('.lane-seg-mark.refused').count()) === 1 && (await label(more)).includes(`${lastKey}: ${lastKey} can't start yet`), HUNG_MS)), await label(more))
    await more.hover()
    check('…said in its hover too', !!(await until(async () => ((await page.locator('.lane-seg-tip').textContent().catch(() => '')) ?? '').includes(`${lastKey} can't start yet`), HUNG_MS)))
    await shoot('folded')

  } finally {
    await app.close().catch(() => undefined)
  }

  // --- In another language: Combwork started again in German, the same lane.
  // The lane's agents were working: Combwork offers to resume them (its restart record), in a notice over the lane's
  // segments (HI-1809: the hover timed out under it). Answered Don't Resume, below, until the record is gone (nothing
  // left to offer) and no offer shows.
  const restartRecord = path.join(userData, 'restart.json')
  const offered = fs.existsSync(restartRecord)
  console.log(`INFO restart record before the restart: ${offered ? 'yes' : 'no'}`)
  const de = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off', CW_LANG: 'de' }) })
  try {
    const page = await de.firstWindow()
    page.on('pageerror', (e) => check('no page errors in German', false, e.message))
    await lib.fitWindow(de, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    if (!(await page.evaluate((n) => document.title.includes(n), path.basename(ws)))) await lib.openWorkspace(inv, page, ws)
    if (offered) {
      const deMain = JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', 'de', 'main.json'), 'utf8'))
      const dontResume = page.locator('.toast').getByRole('button', { name: deMain['main.restart.dismiss'], exact: true })
      const answered = await until(async () => {
        if (await dontResume.count()) await dontResume.first().click().catch(() => undefined)
        return !fs.existsSync(restartRecord) && (await dontResume.count()) === 0
      })
      // Its outcome then shows for the usual time, counted only while the window is focused (Popups.tsx), and a test
      // window never is: closed with its × as the user would (HI-2370).
      const outcome = page.locator('.toast.resolved .popup-close')
      const closed = await until(async () => {
        if (await outcome.count()) await outcome.first().click().catch(() => undefined)
        return (await outcome.count()) === 0
      })
      check("de: the offer to resume the lane's agents answered Don't Resume, and gone", !!answered && !!closed, String(fs.existsSync(restartRecord)))
    }
    if (!(await until(async () => (await page.locator('.progress-panel').count()) === 1, 5000))) await page.locator('.progress-rail').click()
    const seg = page.locator('.progress-lane .lane-seg.todo').first()
    const label = async () => (await seg.getAttribute('aria-label').catch(() => null)) ?? ''
    check('in German, the refused mark is there, said in German', !!(await until(async () => (await seg.locator('.lane-seg-mark.refused').count()) === 1 && /kann noch nicht starten/.test(await label()) && !(await label()).includes("can't start yet"), HUNG_MS)), await label())
    await seg.hover()
    await until(async () => (await page.locator('.lane-seg-tip').count()) === 1, HUNG_MS)
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await seg.hover()
      await until(async () => (await page.locator('.lane-seg-tip').count()) === 1, HUNG_MS)
      await page.screenshot({ path: path.join(shots, `refused-de-${theme}.png`) })
    }
  } finally {
    await de.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
