// A running session's name in its agent's ⋯ (#978: an icon in its footer before): Open in Sessions Tab with the name and
// when it started as its detail: the start time (yyyy-mm-dd hh:mm) until it has a name, renames from the ⋯ (Rename
// Session…) and with /rename (the latest wins), a /rename made before a resume carried over, and the footer's context
// staying whole in a narrow pane. The agent runs the fake Claude Code (fake-claude/). Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'sessionname-profile')
const ws = path.join(lib.WORK, 'sessionname-ws')
const claudeHome = path.join(lib.WORK, 'sessionname-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47898), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Writer' })
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
  const key = lib.ptyKey(alpha, agent.id)
  /**
   * Types a line in the agent's terminal once the fake takes prompts; a prompt waits for its own turn to end (#684,
   * lib.fakePrompts).
   */
  const prompts = lib.fakePrompts(inv, key, live, { home: claudeHome })
  const type = async (text, prompt = true) => {
    const typed = await prompts.type(text)
    if (prompt) check(`the prompt "${text}" is answered`, !!(await prompts.over(typed)))
  }
  const records = () => sessionsOf(alpha).sessions
  const launches = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

  const st = await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 15000)))
  const header = page.locator('.pane-header-bar', { hasText: 'Writer' })
  const footer = page.locator('.agent-pane', { has: header }).locator('.pane-footer-bar')
  const more = header.getByRole('button', { name: 'More', exact: true })
  const openItem = page.locator('.menu .menu-item', { hasText: 'Open in Sessions Tab' })
  /** Opens the agent's ⋯ (closing any menu open first). */
  const openMore = async () => {
    if (await page.locator('.menu').count()) await page.keyboard.press('Escape')
    await more.click()
    await until(() => openItem.isVisible().catch(() => false), HUNG_MS)
  }
  /** Open in Sessions Tab's detail ("<name> · since <when>"), or '' when the ⋯ has none. */
  const detail = async () => {
    await openMore()
    const d = (await openItem.count()) ? ((await openItem.locator('.menu-detail').innerText().catch(() => '')) ?? '') : ''
    await page.keyboard.press('Escape')
    await until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
    return d
  }
  // The session's name: the detail before " · since …".
  const text = async () => (await detail()).replace(/ · since .*$/, '')
  check("the session is in the agent's ⋯, not in its footer or header", !!(await until(async () => (await detail()) !== '', 8000)) && (await footer.locator('.session-tag').count()) === 0 && (await header.locator('.session-tag').count()) === 0)
  // Combwork's automatic name is "alpha · <date>": the footer shows only the start time.
  const auto = records().find((r) => r.id === st.sessionId)?.name ?? ''
  check('Combwork named it automatically and passed that to Claude Code', auto.startsWith('alpha · ') && launches().at(-1).opts['--name'] === auto, auto)
  // The footer and the Sessions tab name it by one time, its record's, which is when the launch started: recorded
  // after it with a time of its own, the two could show different minutes (#630).
  const began = { record: records().find((r) => r.id === st.sessionId)?.createdAt, live: (await live())?.sessionCreatedAt, launch: (await live())?.startedAt }
  check("its record began when the launch did, the footer's time too", !!began.launch && began.record === began.launch && began.live === began.launch, JSON.stringify(began))
  check('until it has a name, it is named by when it started, as yyyy-mm-dd hh:mm', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(await text()), await text())
  check('its detail has when it started, in the same format', / · since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(await detail()), await detail())
  // Settings → General → Date format and Time format: the automatic name follows them, here and in the Sessions tab;
  // Combwork's own record of the name doesn't change.
  await inv('settings:update', { general: { dateFormat: 'dmy', timeFormat: '12h' } })
  const dmy = /^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)$/
  check('dd/mm/yyyy, 12-hour: the name follows', !!(await until(async () => dmy.test(await text()), 5000)), await text())
  const asShown = await text()
  await openMore()
  await openItem.click()
  const startRow = page.locator('.session-row.selected')
  check('…in the Sessions tab too', !!(await until(async () => (await startRow.innerText().catch(() => '')).includes(asShown), 8000)), await startRow.innerText().catch(() => ''))
  await startRow.locator('.session-row-when').hover()
  const whenTip = await until(async () => ((await page.locator('.tip').count()) ? await page.locator('.tip').innerText() : ''), 5000)
  check('…where "how long ago" has the date on hover, in the same format', /^Last active \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)$/.test(whenTip.trim()), whenTip)
  await page.mouse.move(5, 5)
  check("…and Combwork's record of the name is unchanged", records().find((r) => r.id === st.sessionId)?.name === auto)
  // Exported, the title and timestamps follow the format too (the save dialog answered in main, to a test path).
  const exportFile = path.join(lib.WORK, 'sessionname-export.md')
  fs.rmSync(exportFile, { force: true })
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, exportFile)
  await inv('transcript:export', alpha, st.sessionId, asShown)
  const md = fs.existsSync(exportFile) ? fs.readFileSync(exportFile, 'utf8') : ''
  // (Each message's time is checked in core.test.ts: this session has none yet.)
  check('…in an export: its title and "exported from Combwork"', md.startsWith(`# ${asShown}`) && /exported from Combwork \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)/.test(md), md.slice(0, 300))
  // The Overview's session details: when it started and was last active.
  await page.keyboard.press('Alt+2')
  const startedCell = page.locator('tr', { has: page.locator('td', { hasText: /^Started$/ }) }).locator('td').nth(1)
  check("…in the Overview's session details", !!(await until(async () => dmy.test((await startedCell.innerText().catch(() => '')).trim()), 8000)), await startedCell.innerText().catch(() => ''))
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
  await lib.sleep(400)
  await inv('settings:update', { general: { dateFormat: 'ymd', timeFormat: '24h' } })
  check('back to yyyy-mm-dd, 24-hour', !!(await until(async () => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(await text()), 5000)), await text())
  await type('turn 1')
  const ctx = footer.locator('.foot-ctx')
  await until(async () => (await ctx.count()) === 1, 8000)
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-1-start.png') })

  // Rename Session… in the ⋯.
  await openMore()
  await page.locator('.menu .menu-item', { hasText: 'Rename Session…' }).click()
  const dialog = page.locator('[role=dialog]', { hasText: 'Rename session' })
  // The dialog fills in the current name just after it opens: typing before that would add to it.
  await until(async () => (await dialog.count()) === 1 && (await dialog.locator('input').inputValue()) !== '', HUNG_MS)
  await dialog.locator('input').fill('Docs pass')
  await dialog.getByRole('button', { name: 'Rename' }).click()
  check('renamed from the ⋯', !!(await until(async () => (await text()) === 'Docs pass', 5000)), await text())
  const rec = () => records().find((r) => r.id === st.sessionId)
  check('Combwork keeps the name, and what Claude Code called it then', rec().name === 'Docs pass' && rec().titleAtRename === auto, JSON.stringify(rec()))

  // /rename in Claude Code after it: the newer name wins.
  await type('/rename Guide only', false)
  check('a /rename after it wins', !!(await until(async () => (await text()) === 'Guide only', 10000)), await text())
  // The Sessions tab shows the same name.
  await openMore()
  await openItem.click()
  const row = page.locator('.session-row.selected')
  check('the Sessions tab shows it too', !!(await until(async () => /Guide only/.test(await row.innerText().catch(() => '')), 8000)), await row.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-2-sessions.png') })
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
  await lib.sleep(500)

  // Renamed in Combwork again: Combwork's is the newer.
  await inv('session:rename', alpha, st.sessionId, 'Final docs')
  check('a Combwork rename after that wins again', !!(await until(async () => (await text()) === 'Final docs', 5000)), await text())

  // A /rename, then the session stops and is resumed: Combwork takes the name rather than passing its own back.
  await type('/rename Release notes', false)
  check('the /rename shows', !!(await until(async () => (await text()) === 'Release notes', 10000)), await text())
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 10000)
  await inv('session:start', alpha, { agentId: agent.id, resumeId: st.sessionId })
  await until(async () => (await live())?.status === 'ready', 15000)
  check('resumed with the CLI name passed back', launches().at(-1).opts['--name'] === 'Release notes', launches().at(-1).opts['--name'])
  // Unnamed, it would be named by when it began, as in the Sessions tab, not when it was resumed.
  const resumed = { record: rec().createdAt, live: (await live())?.sessionCreatedAt, launch: (await live())?.startedAt }
  check('a resumed session keeps the time it began', resumed.live === resumed.record && resumed.record === began.record && resumed.launch !== resumed.record, JSON.stringify(resumed))
  check('Combwork keeps it as the session name', rec().name === 'Release notes', rec().name)
  check('and the ⋯ still shows it', !!(await until(async () => (await text()) === 'Release notes', 8000)), await text())

  // Narrow, with a long name (in the ⋯ only): the context stays whole.
  await inv('session:rename', alpha, st.sessionId, 'A rather long session name that cannot possibly fit in a narrow pane')
  await until(async () => /rather long/.test(await text()), 5000)
  await lib.fitWindow(app, page, { width: 760, height: 700 })
  await lib.sleep(800)
  const fits = (loc) => loc.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
  check('the context stays whole', await fits(ctx))
  await page.screenshot({ path: path.join(lib.WORK, 'sessionname-3-narrow.png') })

  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
