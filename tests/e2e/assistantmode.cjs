// The Combwork Assistant's working modes (#259). Switching mode from the panel's header while it runs keeps the
// conversation: Combwork types "[CW] Mode: <name> (chosen by the user). <summary> Your tools and permissions are
// unchanged." into it (no restart, the same session), and saves the mode for the workspace. While it is working, the
// message waits until it has finished. Restart in This Mode… (asking first) resumes the same conversation with the
// mode's full instructions: its system prompt is the new mode's at once, not the one its conversation recorded (the
// fake keeps that record as Claude Code does, #334). A conversation resumed in another mode than it was last given (a
// switch while it was stopped) is told that mode once. The menu screenshotted in both themes. The Assistant runs the
// fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'assistantmode-profile')
const ws = path.join(lib.WORK, 'assistantmode-ws')
const claudeHome = path.join(lib.WORK, 'assistantmode-claude-home')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(path.join(ws, 'alpha'))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47910), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const key = lib.ptyKey(home, 'assistant')
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  const agentFile = () => JSON.parse(fs.readFileSync(path.join(home, '.combwork', 'project.json'), 'utf8')).agents?.[0] ?? {}
  const buffer = async () => (await inv('pty:buffer', key)) ?? ''
  const panel = page.locator('.assistant-panel')
  // The conversation as the fake wrote it, and how often Combwork typed a mode message into it.
  const transcript = (id) => {
    const dir = path.join(claudeHome, 'projects')
    for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (fs.existsSync(path.join(dir, d, `${id}.jsonl`))) return fs.readFileSync(path.join(dir, d, `${id}.jsonl`), 'utf8')
    return ''
  }
  const told = (id, mode) => transcript(id).split('\n').filter((l) => l.includes('"type":"user"') && l.includes(`[CW] Mode: ${mode} (chosen by the user)`)).length
  // Each prompt is typed once the fake takes prompts, and waited for by its own turn (#684: under load the status still
  // said the last turn had finished while the fake was still in Combwork's mode message's turn, and dropped "whatmode").
  const prompts = lib.fakePrompts(inv, key, live, { home: claudeHome })
  // Its turn over on its side too (a mode message Combwork typed into it): it takes the next prompt.
  const idle = async () => !!(await lib.until(prompts.takesPrompts, lib.TURN_HUNG_MS))
  // The mode its system prompt is in, as the fake says it for "whatmode" (its recorded prompt unless it was told not to).
  const promptMode = async (id) => {
    const asked = (transcript(id).match(/system prompt mode: /g) ?? []).length
    if (!(await prompts.say('whatmode'))) return '(its turn didn\'t end)'
    await lib.until(async () => (transcript(id).match(/system prompt mode: /g) ?? []).length > asked, HUNG_MS)
    const all = [...transcript(id).matchAll(/system prompt mode: ([^)"]+)\)/g)]
    return all.length > asked ? all[all.length - 1][1] : '(no answer)'
  }
  const record = (id) => sessionsOf(home).sessions.find((s) => s.id === id) ?? {}
  const modeMenu = async () => {
    await panel.locator('.assistant-mode').click()
    await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, HUNG_MS)
  }
  const pick = async (label) => {
    await modeMenu()
    await page.locator('.menu .menu-item', { hasText: label }).first().click()
  }

  // --- The Assistant runs, in Coordinator mode (the default).
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.until(async () => (await panel.locator('.assistant-header').count()) === 1, 5000)
  check('the header shows Coordinator, the default mode', !!(await lib.until(async () => (await panel.locator('.assistant-mode').innerText()).includes('Coordinator'), 5000)), await panel.locator('.assistant-mode').innerText())
  await panel.locator('.assistant-header').getByRole('button', { name: 'Start', exact: true }).click()
  check('the Assistant runs', !!(await lib.until(async () => (await live())?.status === 'ready', 20000)))
  const session = (await live()).sessionId
  const given = fs.readFileSync(path.join(home, '.combwork', 'launch-assistant', 'instructions.md'), 'utf8')
  check('its instructions are the mode, and say it may suggest another', given.includes('# Your mode: Coordinator') && /suggest switching in one short line; never switch or insist/.test(given), given.slice(-400))
  check('…its conversation records the mode it started in', record(session).mode === 'coordinator', JSON.stringify(record(session)))
  check('…and its first request records Coordinator as its system prompt', (await promptMode(session)) === 'Coordinator')

  // --- The menu: the four modes, switching keeps the conversation.
  await modeMenu()
  const items = (await page.locator('.menu .menu-item').allInnerTexts()).map((t) => t.trim())
  check('the menu says switching keeps the conversation, and lists the four modes', (await page.locator('.menu', { hasText: 'Mode (switches now, keeping the conversation)' }).count()) === 1 && ['Coordinator', 'Planner', 'QA triager', 'Release manager'].every((m) => items.some((t) => t.includes(m))), JSON.stringify(items))
  check('…with Restart in This Mode… and Manage Modes…', items.some((t) => t.startsWith('Restart in This Mode')) && items.some((t) => t.startsWith('Manage Modes')), JSON.stringify(items))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300) // on purpose: the theme's colours settle
    await page.screenshot({ path: path.join(lib.WORK, `assistantmode-menu-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.keyboard.press('Escape')

  // --- Idle: told at once, in the same conversation.
  // At once, but under load the fake can lose the Enter after Combwork's line, which Combwork presses again 10 s later (#684): so
  // it is waited for, bounded for a hung run.
  await pick('Planner')
  check('switching to Planner tells it at once, in its conversation', !!(await lib.until(async () => (await buffer()).includes('[CW] Mode: Planner (chosen by the user). Lead with the open design questions'), lib.TURN_HUNG_MS)), (await buffer()).slice(-400))
  check('…ending with Combwork\'s own sentence', !!(await lib.until(async () => (await buffer()).includes('Your tools and permissions are unchanged.'), 10000)), JSON.stringify((await buffer()).slice(-600)))
  check('…without a restart: the same session', (await live())?.sessionId === session, `${session} → ${(await live())?.sessionId}`)
  check('…saved for the workspace, and the header shows it', !!(await lib.until(async () => agentFile().mode === 'planner' && (await panel.locator('.assistant-mode').innerText()).includes('Planner'), 10000)), `${JSON.stringify(agentFile())}; header: ${await panel.locator('.assistant-mode').innerText()}`)
  check('…and recorded as the mode its conversation was last given', !!(await lib.until(async () => record(session).mode === 'planner', 5000)), JSON.stringify(record(session)))

  // --- Working: told once it has finished.
  const working = await prompts.type('work 6')
  check('it works on something', !!(await lib.until(async () => (await live())?.turn?.id !== working.before && (await live())?.status === 'working', lib.TURN_HUNG_MS)), JSON.stringify((await live())?.turn))
  await pick('QA triager')
  await lib.sleep(1000) // on purpose: nothing is typed into a working Assistant
  check('switching while it works types nothing yet', !(await buffer()).includes('[CW] Mode: QA triager'))
  check('…and is saved at once', agentFile().mode === 'qa-triager', JSON.stringify(agentFile()))
  check('…then told once it has finished', !!(await lib.until(async () => (await buffer()).includes('[CW] Mode: QA triager (chosen by the user). Take a report'), lib.TURN_HUNG_MS)))
  check('…and sent (in its conversation once)', !!(await lib.until(async () => told(session, 'QA triager') === 1, lib.TURN_HUNG_MS)), String(told(session, 'QA triager')))
  check('…still the same session', (await live())?.sessionId === session)
  await idle()

  // --- Restart in This Mode: the same conversation, resumed with the mode's full instructions.
  await modeMenu()
  await page.locator('.menu .menu-item', { hasText: 'Restart in This Mode' }).click()
  const ask = page.locator('.dialog', { hasText: 'Restart in QA triager mode?' })
  check('Restart in This Mode asks first, saying it re-caches the conversation', !!(await lib.until(async () => (await ask.count()) === 1, 5000)) && /cached again/.test(await ask.innerText()))
  await ask.getByRole('button', { name: 'Restart', exact: true }).click()
  check('…and resumes the same conversation', !!(await lib.until(async () => (await live())?.status === 'ready' && (await live())?.sessionId === session, 30000)), `${session} → ${(await live())?.sessionId}`)
  const retold = fs.readFileSync(path.join(home, '.combwork', 'launch-assistant', 'instructions.md'), 'utf8')
  check('…with the QA triager mode in its instructions', retold.includes('# Your mode: QA triager'))
  await idle()
  check('…which its resumed conversation uses at once, not the Coordinator prompt it recorded (#334)', (await promptMode(session)) === 'QA triager')
  check("…and, already told QA triager, it isn't told again", told(session, 'QA triager') === 1, String(told(session, 'QA triager')))

  // --- Not running: saved, told nothing (its next launch is in the mode).
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 15000)
  await pick('Release manager')
  check('switching while it is stopped saves the mode for its next launch', !!(await lib.until(async () => agentFile().mode === 'release-manager', 5000)), JSON.stringify(agentFile()))
  check('…and tells nothing yet', told(session, 'Release manager') === 0)

  // --- Resumed after a switch while it was stopped: told the mode once it is idle, once (#334). The fake loses Enter
  // for its first seconds, as Claude Code can while it draws a resumed conversation: Combwork presses it again. Under load
  // that took 24 s (#684), and a prompt typed before it was taken was lost: so it is waited for, bounded for a hung run.
  fs.writeFileSync(path.join(claudeHome, 'fake-resume-draw.json'), JSON.stringify({ ms: 3500 }))
  await inv('session:start', home, { resumeId: session, agentId: 'assistant' })
  check('resumed, the conversation is told its new mode (its first Enter lost)', !!(await lib.until(async () => told(session, 'Release manager') === 1, lib.TURN_HUNG_MS)), transcript(session).slice(-600))
  fs.rmSync(path.join(claudeHome, 'fake-resume-draw.json'))
  check('…the same conversation', (await live())?.sessionId === session)
  const resumedMode = await promptMode(session)
  check("…and its system prompt is the mode's", resumedMode === 'Release manager', resumedMode)
  check('…recorded as the mode it was last given', record(session).mode === 'release-manager', JSON.stringify(record(session)))
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 15000)
  await inv('session:start', home, { resumeId: session, agentId: 'assistant' })
  await idle()
  await lib.sleep(2000) // on purpose: a second message would be typed by now
  check("resumed again in the same mode, it isn't told again", told(session, 'Release manager') === 1, String(told(session, 'Release manager')))
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 15000)

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
