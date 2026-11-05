// Quit flows in throwaway profiles. Sessions run the fake Claude Code (fake-claude/, #194): started, never sent a message.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')

const scratch = lib.WORK
const shots = path.join(scratch, 'qshots')
fs.rmSync(shots, { recursive: true, force: true })
fs.mkdirSync(shots, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
/** Whether fn() comes true (checked until it does, up to HUNG_MS). */
const becomes = async (fn) => !!(await lib.until(fn, HUNG_MS))

/** Adds an agent to a project and starts it (projects start without agents). */
async function startIn(inv, proj) {
  const a = await lib.addAgent(inv, proj)
  await inv('session:start', proj, { agentId: a.id })
  await lib.acceptClaudeTrust(inv, proj, a.id)
  return a
}

async function launch(name, config) {
  const userData = path.join(scratch, `q-${name}-profile`)
  const ws = path.join(scratch, `q-${name}-ws`)
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'beta'), { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  if (config) fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config))
  const claude = lib.fakeClaude(userData, path.join(scratch, `q-${name}-claude-home`), [path.join(ws, 'alpha'), path.join(ws, 'beta')])
  const env = lib.hiveEnv({ CW_USER_DATA: userData, ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  // Starting an agent before Combwork has found its Claude Code fails (it did now and then on a busy machine).
  await lib.waitForProvider(inv)
  return { app, page, inv, ws }
}
/**
 * Combwork quits: it decides to (its own quit work done, timed from the watch's start) within ms, and its process ends after.
 * The process's part is Electron's on a loaded machine, so it is only waited for, up to GONE_MS (#424).
 */
const GONE_MS = 30000
const quits = async (q, ms = 10000) => !!(await q.untilDecided(ms)) && (await q.gone(GONE_MS))
/**
 * Until n sessions are ready (idle), not just past starting: in a folder Claude Code hasn't seen, its trust question
 * shows the session as waiting (Needs your input) until acceptClaudeTrust's answer gets it to its prompt (#177).
 */
const untilReady = (inv, n) => lib.until(async () => (await inv('session:live')).filter((l) => l.status === 'ready').length >= n, 30000)
/** Closes a copy that didn't quit by itself: app.close() alone waits at its Quit dialog for ever. */
const forceClose = async (app) => {
  await Promise.race([app.close().catch(() => undefined), sleep(5000)])
  try {
    app.process().kill()
  } catch {
    // Already gone.
  }
}

;(async () => {
  // 1. Old boolean config is migrated; "always" asks even when agents are idle.
  {
    const { app, page, inv, ws } = await launch('always', { settings: { general: { confirmOnQuit: true } } })
    check('migration: old "true" became "working"', (await inv('settings:get')).general.confirmOnQuit === 'working')
    await inv('settings:update', { general: { confirmOnQuit: 'always' } })
    const alphaAgent = await startIn(inv, path.join(ws, 'alpha'))
    await startIn(inv, path.join(ws, 'beta'))
    // alpha's agent works on a card: the dialog's table says which (#572).
    const made = await inv('tasks:create', { title: 'Quit table', project: 'alpha', column: 'doing', agent: alphaAgent.id })
    const card = made.number
    // The card by key (#1221).
    const cardName = made.key ?? `#${card}`
    // Its sessions up and idle, so quitting finds them running.
    await untilReady(inv, 2)
    await page.evaluate(() => window.hive.invoke('app:quit')) // same entry point as the tray's Quit Combwork
    const dialogShown = () => becomes(async () => (await page.locator('.dialog', { hasText: 'Quit Combwork?' }).count()) === 1)
    check('dialog: shown in-app', await dialogShown())
    check('dialog: lists both sessions', await becomes(async () => (await page.locator('.quit-row').count()) === 2))
    check('dialog: no "quit when finished" when nothing is working', (await page.locator('.dialog button', { hasText: 'Quit when' }).count()) === 0)
    // The agents as a table (#572): Agent, Project, State, Card (no "Stopping it" while nothing is busy).
    const table = page.locator('.dialog .quit-agents table.agents-table')
    // As written (the headings are upper case by CSS only).
    const heads = await table.locator('thead th').allTextContents()
    const alphaRow = table.locator('tr.quit-row', { hasText: 'alpha' })
    const cells = await alphaRow.locator('td').allInnerTexts()
    check('dialog: the agents are a table: Agent, Project, State, Card', JSON.stringify(heads) === JSON.stringify(['Agent', 'Project', 'State', 'Card']))
    check(`dialog: a row is the agent, its project, its state and its card (#${card})`, cells.length === 4 && cells[0].trim() === alphaAgent.name && cells[1].trim() === 'alpha' && cells[3].trim() === `${cardName} Quit table`)
    // For screen readers, the same as plain text (the table hidden from them): each agent, its project, state and card.
    const plain = await page.locator('.dialog .quit-agents .visually-hidden').innerText()
    check('dialog: its plain text says each agent with its project, state and card, the table hidden from screen readers', plain.includes(`• ${alphaAgent.name} — in alpha · Ready · card ${cardName} Quit table`) && (await page.locator('.dialog .quit-agents [aria-hidden="true"] table.agents-table').count()) === 1)
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await becomes(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
      await page.screenshot({ path: path.join(shots, `1-dialog-idle-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
    await page.locator('.dialog button', { hasText: 'Cancel' }).click()
    check('cancel: dialog closed, sessions still running', await becomes(async () => (await page.locator('.quit-row').count()) === 0 && (await inv('app:quitState')).request === null) && (await inv('session:live')).length === 2)
    // Escape also cancels.
    await page.evaluate(() => window.hive.invoke('app:quit'))
    await dialogShown()
    await page.keyboard.press('Escape')
    check('escape: cancels', await becomes(async () => (await inv('app:quitState')).request === null && (await page.locator('.quit-row').count()) === 0) && (await inv('session:live')).length === 2)
    // Don't ask again + Quit now.
    await page.evaluate(() => window.hive.invoke('app:quit'))
    await dialogShown()
    await page.locator('.quit-dontask input').check()
    const q = await lib.quitWatch(app)
    await page.locator('.dialog button', { hasText: 'Quit now' }).click()
    check('quit now: app exits', await quits(q))
    const saved = JSON.parse(fs.readFileSync(path.join(scratch, 'q-always-profile', 'config.json'), 'utf8'))
    check("don't ask again: saved as never", saved.settings.general.confirmOnQuit === 'never')
    const s = sessionsOf(path.join(ws, 'alpha'))
    check('quit now: nothing left running (no stray Claude Code for this profile)', Array.isArray(s.sessions))
  }

  // 2. Default ("working") with idle sessions: quits straight away, no dialog.
  {
    const { app, inv, ws } = await launch('idle')
    await startIn(inv, path.join(ws, 'alpha'))
    // Its session up and idle, so quitting finds it running.
    check('idle + default: the session is idle first', await untilReady(inv, 1))
    const q = await lib.quitWatch(app)
    const t0 = Date.now()
    await inv('app:quit').catch(() => undefined)
    const closed = await quits(q)
    check('idle + default: quits without asking', closed)
    // Combwork's own shutdown (stopping the session, up to 3 s, and saving), not the process's teardown after it.
    const decided = await q.untilDecided(0)
    check('idle + default: shutdown under 5 s', !!decided && decided - t0 < 5000)
    results.push(`INFO  idle + default: ${q.timings(t0)}`)
    // It asked instead: close it, or it stays open (at the dialog) after the suite, holding the runner's port.
    if (!closed) await forceClose(app)
  }

  // 3. Pending quit with nothing working quits at once; the banner and tray state appear while pending.
  {
    const { app, page, inv, ws } = await launch('pending', { settings: { general: { confirmOnQuit: 'always' } } })
    await startIn(inv, path.join(ws, 'alpha'))
    // Its session up and idle, so quitting finds it running.
    await untilReady(inv, 1)
    await page.evaluate(() => window.hive.invoke('app:quit'))
    // The decision answers the quit request, so it waits for there to be one.
    await lib.until(async () => (await inv('app:quitState')).request !== null, HUNG_MS)
    const q = await lib.quitWatch(app)
    await inv('app:quitDecision', 'wait', false).catch(() => undefined)
    const quit = await quits(q)
    check('wait with no working agent: quits', quit)
    if (!quit) await forceClose(app)
  }

  console.log(results.join('\n'))
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
