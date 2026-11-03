// The agent footer's context: tokens only until the CLI reports the context window, then tokens and percentage
// ("20 · 2%"); in a narrow footer only the percentage. Its tooltip ends with "Click to view compaction history".
// A click on it lands on the Overview's compaction history. The agent is the fake Claude Code, whose "window N" makes
// its status line report an N-token window. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'ctxpercent-profile')
const ws = path.join(lib.WORK, 'ctxpercent-ws')
const claudeHome = path.join(lib.WORK, 'ctxpercent-claude-home')
const alpha = path.join(ws, 'alpha')
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
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, claudeHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47905), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Counter' })
  const key = lib.ptyKey(alpha, agent.id)
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await until(async () => (await live())?.status === 'ready', 20000)))
  // Each prompt is typed once the fake takes prompts, and waited for by its own turn (#684, lib.fakePrompts); a
  // compaction is no turn of its own: the fake's screen says when it's over.
  const prompts = lib.fakePrompts(inv, key, live, { home: claudeHome })
  const send = async (text) => {
    if (text.startsWith('/')) await prompts.type(text)
    else check(`the prompt "${text}" is answered`, !!(await prompts.say(text)))
  }
  /** Whether the window shows that theme yet (settings reach it as an event, after settings:update returns). */
  const themeIs = (theme) => async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme
  const footer = page.locator('.pane-footer-bar').first()
  // "ctx 42%", or its tokens while the window isn't known (#978: the tokens are in its tooltip).
  const ctxItem = footer.locator('.foot-ctx')
  const text = () => ctxItem.innerText().catch(() => '')
  const tip = page.locator('.tip .ctx-tip')
  /** The context's tokens and window, as its tooltip's first line says them. */
  const tipFigures = async () => {
    await ctxItem.hover()
    await until(async () => (await tip.count()) === 1, 5000)
    const m = (await tip.innerText().catch(() => '')).match(/^Context: ([\d,]+) tokens(?: of ([\d,]+))?/)
    await page.mouse.move(5, 5)
    await until(async () => (await tip.count()) === 0, 5000)
    return m ? m.slice(1).map((x) => (x ? Number(x.replace(/,/g, '')) : null)) : []
  }

  await send('hello')
  check('without a known window: its tokens', !!(await until(async () => /^\s*ctx \d+(\.\d)?k?$/.test(await text()), 8000)), await text())
  await send('hello again window 1000')
  check('once the CLI reports it: the percentage', !!(await until(async () => /^\s*ctx \d+%$/.test(await text()), 8000)), await text())
  const pct = Number((await text()).match(/(\d+)%/)?.[1])
  const [tokens, win] = await tipFigures()
  check('the percentage is of that window, the tokens in the tooltip', win === 1000 && pct === Math.round((tokens / 1000) * 100), `${tokens} of ${win} tokens, ${pct}%`)
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-1-wide.png') })

  // --- Its tooltip ends with an empty line, then what a click does (#121).
  await ctxItem.hover()
  await until(async () => (await tip.count()) === 1, 5000)
  const lines = (await tip.innerText().catch(() => '')).split('\n')
  check('the tooltip: the context, an empty line, then "Click to view compaction history"', /^Context: \d/.test(lines[0] ?? '') && lines.length >= 3 && lines.at(-2) === '' && lines.at(-1) === 'Click to view compaction history', JSON.stringify(lines))
  // The figure includes the last turn's output (#154), and the tooltip breaks it down.
  const parts = (lines[1] ?? '').match(/^([\d,]+) input \+ ([\d,]+) output of the last turn \(thinking included\)$/)
  const num = (s) => Number(s.replace(/,/g, ''))
  check("…breaking it down: the last turn's input + its output (thinking included), which add up to the figure", !!parts && num(parts[1]) + num(parts[2]) === tokens && num(parts[2]) > 0, JSON.stringify(lines))
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-tip-dark.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await until(themeIs('light'), HUNG_MS)
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-tip-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.mouse.move(5, 5)

  // With a real window (200K), the tooltip says where Claude Code compacts by itself (#154): about 167K.
  await send('and once more window 200000')
  await until(async () => /^\s*ctx 0%$/.test(await text()), 8000)
  await ctxItem.hover()
  check('…and where Claude Code compacts by itself, for a 200K window: its default, nothing set (#242)', !!(await until(async () => (await tip.innerText().catch(() => '')).includes('Claude Code compacts by itself at about 167,000, its default for this window'), 5000)), await tip.innerText().catch(() => ''))
  check("…called an estimate, since policies Combwork can't read could change it (#273)", (await tip.innerText().catch(() => '')).includes("(an estimate: managed policies Combwork can't read"), await tip.innerText().catch(() => ''))
  await page.mouse.move(5, 5)

  // --- A narrow footer keeps the percentage whole (the model and the mode give way first: footerfit has the order).
  const shows = () => ctxItem.evaluate((el) => {
    const t = el.querySelector('.ctx-text')
    return { width: t?.clientWidth ?? -1, full: t?.scrollWidth ?? -1 }
  })
  await footer.evaluate((el) => (el.style.width = '220px'))
  const narrow = await until(async () => {
    const r = await shows()
    return r.width > 0 && r.width >= r.full && r
  }, HUNG_MS)
  check('narrow (220 px): the percentage is whole', !!narrow, JSON.stringify(await shows()))
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-2-narrow.png') })
  await footer.evaluate((el) => (el.style.width = ''))

  // --- A click on it lands on the Overview's compaction history (#124, the link #121 announces): the session compacts
  // first, so there is one.
  await send('/compact')
  // The compaction reaches the session's usage (what the Overview lists) once the CLI has written it.
  await until(async () => (await inv('session:list', alpha)).some((x) => x.usage?.compactions?.length), 15000)
  await ctxItem.click()
  const history = page.locator('#compaction-history')
  const historyRows = page.locator('.compaction-history tbody tr:not(.table-no-match)')
  check('a click on the context opens the Overview at its compaction history', !!(await until(async () => (await history.count()) === 1 && (await historyRows.count()) === 1, 20000)), String(await historyRows.count()))
  check('…scrolled into view', !!(await until(async () => history.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight - 40 }), 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-3-history.png') })

  // --- Claude Code's settings, read at launch (#242): a window set in the project's .claude/settings.local.json, then
  // auto-compaction turned off in its settings.json. A new session each time, with a 200K window.
  const restartWith = async (file, json) => {
    await inv('session:stop', alpha, agent.id).catch(() => undefined)
    await until(async () => !(await live()), 10000)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(json))
    await inv('session:start', alpha, { agentId: agent.id })
    await until(async () => (await live())?.status === 'ready', 20000)
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    await send('hello window 200000')
    await until(async () => /^\s*\d+ ·\s+\d+%$/.test(await text()), 8000)
    await page.mouse.move(5, 5)
    await ctxItem.hover()
    await until(async () => (await tip.count()) === 1, 5000)
  }
  const localSettings = path.join(alpha, '.claude', 'settings.local.json')
  await restartWith(localSettings, { autoCompactWindow: 150000 })
  check("a window in the project's settings: where it compacts then, and why", !!(await until(async () => (await tip.innerText().catch(() => '')).includes("Claude Code compacts by itself at about 117,000: its auto-compact window is 150,000 (autoCompactWindow in the project's .claude/settings.local.json)"), 5000)), await tip.innerText().catch(() => ''))
  check('…in the session as read at launch', JSON.stringify((await live())?.autoCompact) === JSON.stringify({ window: 150000, source: "autoCompactWindow in the project's .claude/settings.local.json" }), JSON.stringify((await live())?.autoCompact))
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-autocompact-dark.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await until(themeIs('light'), HUNG_MS)
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-autocompact-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  fs.rmSync(localSettings, { force: true })
  await restartWith(path.join(claudeHome, 'settings.json'), { autoCompactEnabled: false })
  check("auto-compaction off in Claude Code's settings: it says it doesn't compact by itself", !!(await until(async () => (await tip.innerText().catch(() => '')).includes("Claude Code doesn't compact by itself: auto-compaction is off (autoCompactEnabled: false in Claude Code's settings.json)"), 5000)), await tip.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-autocompact-off.png') })
  // DISABLE_AUTO_COMPACT in the sessions' environment (the test Hive's own, which sessions inherit) turns it off even
  // over settings that turn it on.
  await app.evaluate(() => void (process.env.DISABLE_AUTO_COMPACT = '1'))
  await restartWith(path.join(claudeHome, 'settings.json'), { autoCompactEnabled: true })
  check('DISABLE_AUTO_COMPACT=1 turns it off over settings that turn it on', !!(await until(async () => (await tip.innerText().catch(() => '')).includes("Claude Code doesn't compact by itself: auto-compaction is off (DISABLE_AUTO_COMPACT)"), 5000)), await tip.innerText().catch(() => ''))
  await app.evaluate(() => void delete process.env.DISABLE_AUTO_COMPACT)
  // A window set through Claude Code's settings env block (#273): read as Claude Code reads it, over the environment.
  await restartWith(path.join(claudeHome, 'settings.json'), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' } })
  check("a window in the env block of Claude Code's settings: shown, and why (#273)", !!(await until(async () => (await tip.innerText().catch(() => '')).includes("Claude Code compacts by itself at about 117,000: its auto-compact window is 150,000 (CLAUDE_CODE_AUTO_COMPACT_WINDOW (env in Claude Code's settings.json))"), 5000)), await tip.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'ctxpercent-autocompact-env.png') })
  fs.rmSync(path.join(claudeHome, 'settings.json'), { force: true })
  // A --settings file in the agent's own arguments (#273): the command line's settings, over the project's.
  await lib.setProjectLaunch(inv, alpha, 'claude-code', { extraArgs: '--settings cli-settings.json' })
  await restartWith(path.join(alpha, 'cli-settings.json'), { autoCompactWindow: 250000 })
  check('a window in a --settings file of its arguments: read at launch, and why (#273)', JSON.stringify((await live())?.autoCompact) === JSON.stringify({ window: 250000, source: 'autoCompactWindow in --settings cli-settings.json' }), JSON.stringify((await live())?.autoCompact))
  // Hive merges the user's --settings into its own launch settings and passes that alone (#330): the status line still
  // reports the session's window (the setting's 250,000 capped at its 200,000), and the CLI was given one --settings
  // holding Hive's hooks with the user's setting.
  check('…and the tooltip shows it: the status line still reports (#330)', !!(await until(async () => / of 200,000\n[\s\S]*its auto-compact window is 200,000 \(autoCompactWindow in --settings cli-settings\.json\)/.test(await tip.innerText().catch(() => '')), 5000)), await tip.innerText().catch(() => ''))
  const lastLaunch = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop()
  const given = lastLaunch?.opts?.['--settings'] ? JSON.parse(fs.readFileSync(lastLaunch.opts['--settings'], 'utf8')) : null
  check("…given Hive's settings file, with Hive's hooks and status line and the user's setting merged in (#330)", path.dirname(lastLaunch?.opts?.['--settings'] ?? '').toLowerCase().startsWith(path.join(userData, 'launches').toLowerCase()) && given?.autoCompactWindow === 250000 && !!given?.hooks?.Stop && !!given?.statusLine, JSON.stringify(lastLaunch?.opts))
  await lib.setProjectLaunch(inv, alpha, 'claude-code', { extraArgs: '' })
  fs.rmSync(path.join(alpha, 'cli-settings.json'), { force: true })
  // --setting-sources leaving the project's files out (#333): Hive doesn't read them either, so the window set there
  // isn't shown (Claude Code 2.1.292 reads only the sources it names).
  await lib.setProjectLaunch(inv, alpha, 'claude-code', { extraArgs: '--setting-sources=user' })
  await restartWith(localSettings, { autoCompactWindow: 150000 })
  check("a window in a project file --setting-sources leaves out: not read, Claude Code's default (#333)", (await live())?.autoCompact?.window === null && (await live())?.autoCompact?.source === null && /its default for this window/.test(await tip.innerText().catch(() => '')), JSON.stringify((await live())?.autoCompact))
  await lib.setProjectLaunch(inv, alpha, 'claude-code', { extraArgs: '' })
  fs.rmSync(localSettings, { force: true })
  await page.mouse.move(5, 5)

  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
